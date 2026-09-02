import {
  DatabasePluginInputError,
  type BundleEventRow,
} from "@hot-updater/plugin-core";
import {
  assertInsightsEventContract,
  canonicalInsightsJson,
  INSIGHTS_MAINTENANCE_INPUT_MAX_BYTES,
  INSIGHTS_STRING_MAX_CODE_UNITS,
  isCanonicalInsightsEventId,
  isCanonicalInsightsDatabaseNamespace,
} from "@hot-updater/plugin-core/internal";
import { sql } from "drizzle-orm";

import type { DrizzleProvider } from "../../drizzle";
import {
  mutateDrizzleInsights,
  queryDrizzleInsights,
  transactDrizzleInsights,
  type DrizzleDB,
} from "../../drizzleLazyDB";
import {
  assertDrizzleInsightsIndexes,
  DRIZZLE_INSIGHTS_EVENTS,
  DRIZZLE_INSIGHTS_STATE,
  ensureDrizzleInsightsSchema,
} from "./schema";
import {
  drizzleInsightsRawEventColumns,
  getDrizzleInsightsEventBytes,
  insertDrizzleRawEvent,
  persistDrizzleInsightsProjection,
  type DrizzleInsightsRawEventColumn,
} from "./storage";

const PREPARATION_ROWS = 200;

export const assertDrizzleInsightsDatabaseNamespace = (
  databaseNamespace: string,
): void => {
  if (!isCanonicalInsightsDatabaseNamespace(databaseNamespace)) {
    throw new DatabasePluginInputError("invalid-query");
  }
};

const legacyOrder = (provider: DrizzleProvider) =>
  provider === "sqlite"
    ? sql`cast(id as blob)`
    : provider === "mysql"
      ? sql`cast(id as binary)`
      : sql`id`;

const legacyAfter = (provider: DrizzleProvider, id: string) =>
  provider === "sqlite"
    ? sql`cast(id as blob) > cast(${id} as blob)`
    : provider === "mysql"
      ? sql`cast(id as binary) > cast(${id} as binary)`
      : sql`id > ${id}`;

const legacyAtMost = (provider: DrizzleProvider, id: string) =>
  provider === "sqlite"
    ? sql`cast(id as blob) <= cast(${id} as blob)`
    : provider === "mysql"
      ? sql`cast(id as binary) <= cast(${id} as binary)`
      : sql`id <= ${id}`;

const legacyValue = (provider: DrizzleProvider, id: string) =>
  provider === "sqlite"
    ? sql`cast(${id} as blob)`
    : provider === "mysql"
      ? sql`cast(${id} as binary)`
      : sql`${id}`;

const legacyText = (
  provider: DrizzleProvider,
  column: DrizzleInsightsRawEventColumn,
) => {
  const identifier = sql.identifier(column);
  return provider === "mysql"
    ? sql`cast(${identifier} as char)`
    : provider === "postgresql"
      ? sql`${identifier}::text`
      : sql`cast(${identifier} as text)`;
};

const legacyLength = (
  provider: DrizzleProvider,
  column: DrizzleInsightsRawEventColumn,
  bytes: boolean,
) => {
  const identifier = sql.identifier(column);
  if (provider === "sqlite") {
    return bytes
      ? sql`length(cast(coalesce(${identifier},'') as blob))`
      : sql`length(cast(coalesce(${identifier},'') as text))`;
  }
  if (provider === "mysql") {
    return bytes
      ? sql`octet_length(coalesce(${identifier},''))`
      : sql`char_length(coalesce(${identifier},''))`;
  }
  return bytes
    ? sql`octet_length(coalesce(${identifier}::text,''))`
    : sql`char_length(coalesce(${identifier}::text,''))`;
};

const legacyMetadata = (provider: DrizzleProvider) => {
  const lengths = drizzleInsightsRawEventColumns.map((column) =>
    legacyLength(provider, column, false),
  );
  const bytes = drizzleInsightsRawEventColumns.map((column) =>
    legacyLength(provider, column, true),
  );
  const greatest =
    provider === "sqlite"
      ? sql`max(${sql.join(lengths, sql.raw(","))})`
      : sql`greatest(${sql.join(lengths, sql.raw(","))})`;
  return sql`substr(${legacyText(provider, "id")},1,${INSIGHTS_STRING_MAX_CODE_UNITS + 1}) id,
    ${greatest} max_units,(${sql.join(bytes, sql.raw("+"))}) total_bytes`;
};

type LegacyMetadata = {
  readonly id: unknown;
  readonly max_units: unknown;
  readonly total_bytes: unknown;
};

export type DrizzleInsightsSourceState = {
  readonly revision: number;
  readonly sourceId: string;
  readonly status: "new" | "preparing" | "ready" | "failed";
  readonly upperId: string | null;
  readonly afterId: string | null;
  readonly error: string | null;
  readonly committedSeq: number;
};

const invalid = (): never => {
  throw new DatabasePluginInputError("invalid-result");
};

const asInteger = (value: unknown): number => {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed < 0)
    return invalid();
  return parsed;
};

const readState = (
  row: Record<string, unknown> | undefined,
  databaseNamespace: string,
): DrizzleInsightsSourceState => {
  if (row === undefined) return invalid();
  const status = row["status"];
  if (
    status !== "new" &&
    status !== "preparing" &&
    status !== "ready" &&
    status !== "failed"
  ) {
    return invalid();
  }
  const sourceId = row["source_id"];
  const upperId = row["upper_id"];
  const afterId = row["after_id"];
  const error = row["error"];
  if (
    typeof sourceId !== "string" ||
    sourceId !== databaseNamespace ||
    (upperId !== null && typeof upperId !== "string") ||
    (afterId !== null && typeof afterId !== "string") ||
    (error !== null && typeof error !== "string")
  ) {
    return invalid();
  }
  return {
    revision: asInteger(row["revision"]),
    sourceId,
    status,
    upperId,
    afterId,
    error,
    committedSeq: asInteger(row["committed_seq"]),
  };
};

const selectState = async (db: DrizzleDB, databaseNamespace: string) =>
  assertStateRevision(
    readState(
      (
        await queryDrizzleInsights(
          db,
          sql`select revision,source_id,status,
        upper_id,after_id,error,committed_seq from ${sql.identifier(DRIZZLE_INSIGHTS_STATE)}
        where id=1`,
        )
      )[0],
      databaseNamespace,
    ),
  );

const assertStateRevision = (
  state: DrizzleInsightsSourceState,
): DrizzleInsightsSourceState => {
  if (state.revision !== 1) return invalid();
  return state;
};

export const lockDrizzleInsightsSourceFence = async (
  db: DrizzleDB,
  provider: DrizzleProvider,
  databaseNamespace: string,
): Promise<DrizzleInsightsSourceState> => {
  if (provider === "sqlite") {
    await mutateDrizzleInsights(
      db,
      sql`update ${sql.identifier(DRIZZLE_INSIGHTS_STATE)} set
        committed_seq=committed_seq where id=1`,
    );
  }
  return assertStateRevision(
    readState(
      (
        await queryDrizzleInsights(
          db,
          sql`select revision,source_id,status,upper_id,after_id,error,
              committed_seq from ${sql.identifier(DRIZZLE_INSIGHTS_STATE)}
            where id=1 ${provider === "sqlite" ? sql`` : sql`for update`}`,
        )
      )[0],
      databaseNamespace,
    ),
  );
};

const updateCommittedFence = (db: DrizzleDB) =>
  mutateDrizzleInsights(
    db,
    sql`update ${sql.identifier(DRIZZLE_INSIGHTS_STATE)} set
      committed_seq=(select coalesce(max(seq),0)
        from ${sql.identifier(DRIZZLE_INSIGHTS_EVENTS)}),
      updated_at_ms=${Date.now()} where id=1`,
  );

const readLegacyEvent = (row: Record<string, unknown>): BundleEventRow => {
  const event = {
    ...row,
    received_at_ms: asInteger(row["received_at_ms"]),
  };
  assertInsightsEventContract(event);
  return event;
};

export const createDrizzleInsightsSource = (
  db: DrizzleDB,
  provider: DrizzleProvider,
  databaseNamespace: string,
) => {
  assertDrizzleInsightsDatabaseNamespace(databaseNamespace);
  let schema: Promise<void> | undefined;
  const ensure = (): Promise<void> =>
    (schema ??= ensureDrizzleInsightsSchema(
      db,
      provider,
      databaseNamespace,
    ).catch((error) => {
      schema = undefined;
      throw error;
    }));

  const fail = async (error: unknown): Promise<DrizzleInsightsSourceState> => {
    const message =
      error instanceof Error ? error.message.slice(0, 1024) : "invalid-event";
    await mutateDrizzleInsights(
      db,
      sql`update ${sql.identifier(DRIZZLE_INSIGHTS_STATE)} set
        status='failed',error=${message},updated_at_ms=${Date.now()}
        where id=1 and status<>'ready'`,
    );
    return selectState(db, databaseNamespace);
  };

  return {
    ensure,
    async assertReadyLayout(): Promise<void> {
      await ensure();
      await assertDrizzleInsightsIndexes(db, provider);
    },
    readState: async (): Promise<DrizzleInsightsSourceState> => {
      await ensure();
      return selectState(db, databaseNamespace);
    },
    async advanceStep(
      maxRows = PREPARATION_ROWS,
      process = true,
      layoutReady = false,
    ): Promise<{
      readonly state: DrizzleInsightsSourceState;
      readonly items: number;
      readonly bytes: number;
    }> {
      if (
        !Number.isSafeInteger(maxRows) ||
        maxRows < 1 ||
        maxRows > PREPARATION_ROWS
      ) {
        return invalid();
      }
      if (!layoutReady) await ensure();
      await assertDrizzleInsightsIndexes(db, provider);
      let state = await selectState(db, databaseNamespace);
      if (state.status === "ready" || state.status === "failed" || !process) {
        return { state, items: 0, bytes: 0 };
      }
      if (state.status === "new") {
        try {
          state = await transactDrizzleInsights(db, async (transaction) => {
            const locked = await lockDrizzleInsightsSourceFence(
              transaction,
              provider,
              databaseNamespace,
            );
            if (locked.status !== "new") return locked;
            const upper = await queryDrizzleInsights<{
              id: unknown;
              id_units: unknown;
            }>(
              transaction,
              sql`select substr(${legacyText(provider, "id")},1,
                  ${INSIGHTS_STRING_MAX_CODE_UNITS + 1}) id,
                  ${legacyLength(provider, "id", false)} id_units
                from ${sql.identifier("bundle_events")}
                order by ${legacyOrder(provider)} desc limit 1`,
            );
            const upperId = upper[0]?.id;
            if (
              upperId !== undefined &&
              (typeof upperId !== "string" ||
                asInteger(upper[0]?.id_units) > INSIGHTS_STRING_MAX_CODE_UNITS)
            ) {
              throw new Error("invalid legacy event identifier");
            }
            await mutateDrizzleInsights(
              transaction,
              sql`update ${sql.identifier(DRIZZLE_INSIGHTS_STATE)} set
                status=${upperId === undefined ? "ready" : "preparing"},
                upper_id=${upperId ?? null},after_id=null,error=null,
                updated_at_ms=${Date.now()} where id=1 and status='new'`,
            );
            return selectState(transaction, databaseNamespace);
          });
        } catch (error) {
          return { state: await fail(error), items: 0, bytes: 0 };
        }
        return { state, items: 0, bytes: 0 };
      }
      if (state.upperId === null) {
        return {
          state: await fail(new Error("missing upper id")),
          items: 0,
          bytes: 0,
        };
      }
      const metadata = await queryDrizzleInsights<LegacyMetadata>(
        db,
        sql`select ${legacyMetadata(provider)}
          from ${sql.identifier("bundle_events")}
          where ${legacyAtMost(provider, state.upperId)}
          ${state.afterId === null ? sql`` : sql`and ${legacyAfter(provider, state.afterId)}`}
          order by ${legacyOrder(provider)} asc limit ${maxRows}`,
      );
      const events: BundleEventRow[] = [];
      let bytes = 0;
      try {
        const selected: { readonly id: string }[] = [];
        let materializedBytes = Buffer.byteLength(
          JSON.stringify(metadata),
          "utf8",
        );
        if (materializedBytes > INSIGHTS_MAINTENANCE_INPUT_MAX_BYTES) {
          throw new DatabasePluginInputError("invalid-result");
        }
        for (const item of metadata) {
          const id = item.id;
          const totalBytes = asInteger(item.total_bytes);
          if (
            typeof id !== "string" ||
            !isCanonicalInsightsEventId(id) ||
            asInteger(item.max_units) > INSIGHTS_STRING_MAX_CODE_UNITS ||
            totalBytes > INSIGHTS_MAINTENANCE_INPUT_MAX_BYTES
          ) {
            throw new Error("invalid legacy event");
          }
          if (
            materializedBytes + totalBytes >
            INSIGHTS_MAINTENANCE_INPUT_MAX_BYTES
          ) {
            if (selected.length === 0) {
              throw new DatabasePluginInputError("invalid-result");
            }
            break;
          }
          materializedBytes += totalBytes;
          selected.push({ id });
        }
        const rows =
          selected.length === 0
            ? []
            : await queryDrizzleInsights(
                db,
                sql`select * from ${sql.identifier("bundle_events")}
                  where ${legacyOrder(provider)} in (${sql.join(
                    selected.map(({ id }) => legacyValue(provider, id)),
                    sql.raw(","),
                  )}) order by ${legacyOrder(provider)} asc`,
              );
        if (rows.length !== selected.length) {
          throw new Error("missing legacy event");
        }
        for (const [index, row] of rows.entries()) {
          if (row["id"] !== selected[index]?.id) {
            throw new Error("invalid legacy event order");
          }
          const event = readLegacyEvent(row);
          bytes += getDrizzleInsightsEventBytes(event);
          if (bytes > INSIGHTS_MAINTENANCE_INPUT_MAX_BYTES) {
            throw new DatabasePluginInputError("invalid-result");
          }
          events.push(event);
        }
      } catch (error) {
        return { state: await fail(error), items: 0, bytes: 0 };
      }
      try {
        const afterMatches =
          state.afterId === null
            ? sql`after_id is null`
            : sql`after_id=${state.afterId}`;
        const staleCheckpoint = {};
        try {
          await transactDrizzleInsights(db, async (transaction) => {
            const locked = await lockDrizzleInsightsSourceFence(
              transaction,
              provider,
              databaseNamespace,
            );
            if (
              locked.sourceId !== state.sourceId ||
              locked.status !== "preparing" ||
              locked.afterId !== state.afterId
            ) {
              throw staleCheckpoint;
            }
            for (const event of events) {
              await persistDrizzleInsightsProjection(
                transaction,
                provider,
                event,
                true,
              );
            }
            const afterId = events.at(-1)?.id ?? state.afterId;
            const ready =
              metadata.length < maxRows && events.length === metadata.length;
            await updateCommittedFence(transaction);
            await mutateDrizzleInsights(
              transaction,
              sql`update ${sql.identifier(DRIZZLE_INSIGHTS_STATE)} set
                status=${ready ? "ready" : "preparing"},after_id=${afterId},
                error=null,updated_at_ms=${Date.now()}
                where id=1 and source_id=${state.sourceId} and status='preparing'
                  and ${afterMatches}`,
            );
          });
        } catch (error) {
          if (error !== staleCheckpoint) throw error;
        }
      } catch (error) {
        return { state: await fail(error), items: 0, bytes: 0 };
      }
      return {
        state: await selectState(db, databaseNamespace),
        items: events.length,
        bytes,
      };
    },
    async append(event: BundleEventRow): Promise<void> {
      assertInsightsEventContract(event);
      // Encoding before opening the transaction also rejects cyclic/provider
      // extension records without leaving either physical source half-written.
      canonicalInsightsJson(event);
      const append = async () => {
        await ensure();
        await transactDrizzleInsights(db, async (transaction) => {
          const state = await lockDrizzleInsightsSourceFence(
            transaction,
            provider,
            databaseNamespace,
          );
          if (state.status === "failed") {
            throw new DatabasePluginInputError("invalid-data");
          }
          await insertDrizzleRawEvent(transaction, event);
          await persistDrizzleInsightsProjection(
            transaction,
            provider,
            event,
            false,
          );
          await updateCommittedFence(transaction);
        });
      };
      return append();
    },
    async sourceMaxSequence(): Promise<number> {
      await ensure();
      return (await selectState(db, databaseNamespace)).committedSeq;
    },
  };
};
