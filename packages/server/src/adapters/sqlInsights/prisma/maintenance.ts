import {
  DatabasePluginInputError,
  type BundleEventRow,
} from "@hot-updater/plugin-core";
import {
  INSIGHTS_EVENT_MAX_BYTES,
  INSIGHTS_MAINTENANCE_INPUT_MAX_BYTES,
  INSIGHTS_MAINTENANCE_MAX_ITEMS,
  INSIGHTS_MAINTENANCE_MAX_REQUESTS,
  assertInsightsEventContract,
  getCanonicalInsightsJsonByteLength,
} from "@hot-updater/plugin-core/internal";

import type { ORMSQLProvider } from "../../../db/types";
import {
  parsePrismaBundleEventRow,
  prismaBundleEventFields,
} from "../../prismaRows";
import { backfillPrismaInsightsEvents } from "./append";
import {
  PrismaInsightsSql,
  executePrismaInsights,
  runPrismaInsightsTransaction,
  type PrismaInsightsClient,
  type PrismaInsightsRawClient,
} from "./client";
import {
  createPrismaInsightsLayout,
  hasCompletePrismaInsightsLayout,
  PRISMA_INSIGHTS_STATE,
  PRISMA_INSIGHTS_MIGRATION_COLUMN,
} from "./schema";
import { readPrismaInsightsState } from "./source";
import {
  assertPrismaInsightsDatabaseNamespace,
  prismaInsightsSafeInteger,
} from "./utils";

export class PrismaInsightsMigrationPoisonError extends Error {
  readonly name = "PrismaInsightsMigrationPoisonError";

  constructor(readonly eventId: string) {
    super(`Invalid legacy Insights event ${eventId}`);
  }
}

type MigrationState = {
  ready: boolean | number;
  failed_reason: string | null;
  migration_initialized: boolean | number;
  migration_upper_id: string | null;
  migration_after_id: string | null;
};

const isTrue = (value: boolean | number): boolean =>
  value === true || value === 1;

const readMigrationState = async (
  client: PrismaInsightsRawClient,
  provider: ORMSQLProvider,
): Promise<MigrationState> => {
  const rows = await client.$queryRawUnsafe<MigrationState[]>(
    `select ready,failed_reason,migration_initialized,migration_upper_id,
      migration_after_id from ${PRISMA_INSIGHTS_STATE}${
        provider === "mssql" ? " with (updlock,holdlock)" : ""
      } where id=1${provider === "mysql" ? " for update" : ""}`,
  );
  const state = rows[0];
  if (state === undefined) {
    throw new DatabasePluginInputError("invalid-result");
  }
  return state;
};

const legacyOrderExpression = (provider: ORMSQLProvider): string => {
  switch (provider) {
    case "postgresql":
      return 'id collate "C"';
    case "cockroachdb":
      return PRISMA_INSIGHTS_MIGRATION_COLUMN;
    case "mysql":
      return "cast(id as binary)";
    case "sqlite":
      return "cast(id as blob)";
    case "mssql":
      return PRISMA_INSIGHTS_MIGRATION_COLUMN;
  }
};

const legacyValueExpression = (
  provider: ORMSQLProvider,
  marker: string,
): string => {
  switch (provider) {
    case "postgresql":
      return `${marker} collate "C"`;
    case "cockroachdb":
      return `${marker}::bytes`;
    case "mysql":
      return `cast(${marker} as binary)`;
    case "sqlite":
      return `cast(${marker} as blob)`;
    case "mssql":
      return `convert(binary(32),hashbytes('SHA2_256',convert(nvarchar(max),${marker})))`;
  }
};

const readLegacyUpperId = async (
  client: PrismaInsightsRawClient,
  provider: ORMSQLProvider,
): Promise<string | null> => {
  const order = legacyOrderExpression(provider);
  const top = provider === "mssql" ? "top (1) " : "";
  const limit = provider === "mssql" ? "" : " limit 1";
  const rows = await client.$queryRawUnsafe<{ id: unknown }[]>(
    `select ${top}id from bundle_events order by ${order} desc${limit}`,
  );
  const id = rows[0]?.id;
  if (id === undefined) return null;
  if (typeof id !== "string")
    throw new DatabasePluginInputError("invalid-result");
  return id;
};

const initializeStatement = (
  provider: ORMSQLProvider,
  upperId: string | null,
) => {
  const sql = new PrismaInsightsSql(provider);
  const initialized = provider === "mssql" || provider === "sqlite" ? 1 : true;
  const ready = upperId === null && initialized;
  return sql.statement(
    `update ${PRISMA_INSIGHTS_STATE} set migration_initialized=${sql.value(initialized)},
      migration_upper_id=${sql.value(upperId)},migration_after_id=null,
      ready=${sql.value(ready)},failed_reason=null where id=1`,
  );
};

const checkpointStatement = (
  provider: ORMSQLProvider,
  afterId: string,
  ready: boolean,
) => {
  const sql = new PrismaInsightsSql(provider);
  return sql.statement(
    `update ${PRISMA_INSIGHTS_STATE} set migration_after_id=${sql.value(afterId)},
      ready=${sql.value(provider === "mssql" || provider === "sqlite" ? Number(ready) : ready)}
      where id=1 and failed_reason is null`,
  );
};

const markPoison = async (
  client: PrismaInsightsRawClient,
  provider: ORMSQLProvider,
  eventId: string,
): Promise<void> => {
  const sql = new PrismaInsightsSql(provider);
  await executePrismaInsights(
    client,
    sql.statement(
      `update ${PRISMA_INSIGHTS_STATE} set ready=${sql.value(provider === "mssql" || provider === "sqlite" ? 0 : false)},
       failed_reason=${sql.value(`migration-poison:${eventId}`)} where id=1`,
    ),
  );
};

const legacyBounds = (
  provider: ORMSQLProvider,
  state: MigrationState,
  sql: PrismaInsightsSql,
): string => {
  if (state.migration_upper_id === null)
    throw new DatabasePluginInputError("invalid-result");
  const order = legacyOrderExpression(provider);
  const conditions: string[] = [];
  if (state.migration_after_id !== null) {
    conditions.push(
      `${order}>${legacyValueExpression(
        provider,
        sql.value(state.migration_after_id),
      )}`,
    );
  }
  conditions.push(
    `${order}<=${legacyValueExpression(
      provider,
      sql.value(state.migration_upper_id),
    )}`,
  );
  return conditions.join(" and ");
};

const legacyByteLengthExpression = (provider: ORMSQLProvider): string => {
  const fields = prismaBundleEventFields.filter(
    (field) => field !== "received_at_ms",
  );
  const length = (field: string) => {
    switch (provider) {
      case "postgresql":
        return `octet_length(coalesce(${field},''))`;
      case "cockroachdb":
        return `octet_length(coalesce(${field}::string,''))`;
      case "mysql":
        return `octet_length(coalesce(${field},''))`;
      case "sqlite":
        return `length(cast(coalesce(${field},'') as blob))`;
      case "mssql":
        return `datalength(convert(varchar(max),coalesce(${field},N'') collate Latin1_General_100_BIN2_UTF8))`;
    }
  };
  return fields.map(length).join("+");
};

const legacyIdPreviewExpression = (provider: ORMSQLProvider): string => {
  switch (provider) {
    case "postgresql":
    case "mysql":
      return "left(id,128)";
    case "cockroachdb":
      return "left(id::string,128)";
    case "sqlite":
      return "substr(id,1,128)";
    case "mssql":
      return "left(convert(nvarchar(max),id),128)";
  }
};

type LegacyCandidate = { id_preview: unknown; raw_bytes: unknown };

const readLegacyCandidateCount = async (
  client: PrismaInsightsRawClient,
  provider: ORMSQLProvider,
  state: MigrationState,
  limit: number,
): Promise<number> => {
  if (state.migration_upper_id === null) return 0;
  const sql = new PrismaInsightsSql(provider);
  const where = legacyBounds(provider, state, sql);
  const limitMarker = sql.value(limit);
  const top = provider === "mssql" ? `top (${limitMarker}) ` : "";
  const suffix = provider === "mssql" ? "" : ` limit ${limitMarker}`;
  const statement = sql.statement(
    `select ${top}${legacyIdPreviewExpression(provider)} as id_preview,
       ${legacyByteLengthExpression(provider)} as raw_bytes
     from bundle_events where ${where}
     order by ${legacyOrderExpression(provider)} asc${suffix}`,
  );
  const candidates = await client.$queryRawUnsafe<LegacyCandidate[]>(
    statement.query,
    ...statement.values,
  );
  let estimatedBytes = 0;
  let count = 0;
  for (const candidate of candidates) {
    if (typeof candidate.id_preview !== "string")
      throw new PrismaInsightsMigrationPoisonError("unknown");
    const rawBytes = prismaInsightsSafeInteger(candidate.raw_bytes);
    if (rawBytes > INSIGHTS_EVENT_MAX_BYTES)
      throw new PrismaInsightsMigrationPoisonError(candidate.id_preview);
    // JSON escaping can expand one source byte to six bytes. The fixed margin
    // covers field names, punctuation and the numeric timestamp before any
    // full legacy row is materialized.
    const nextEstimated = estimatedBytes + rawBytes * 6 + 4_096;
    if (nextEstimated > INSIGHTS_MAINTENANCE_INPUT_MAX_BYTES) break;
    estimatedBytes = nextEstimated;
    count += 1;
  }
  return count;
};

const readLegacyPage = async (
  client: PrismaInsightsRawClient,
  provider: ORMSQLProvider,
  state: MigrationState,
  limit: number,
): Promise<readonly BundleEventRow[]> => {
  if (state.migration_upper_id === null) return [];
  const sql = new PrismaInsightsSql(provider);
  const order = legacyOrderExpression(provider);
  const where = legacyBounds(provider, state, sql);
  const limitMarker = sql.value(limit);
  const top = provider === "mssql" ? `top (${limitMarker}) ` : "";
  const suffix = provider === "mssql" ? "" : ` limit ${limitMarker}`;
  const rows = await client.$queryRawUnsafe<unknown[]>(
    `select ${top}${prismaBundleEventFields.join(",")}
     from bundle_events where ${where}
     order by ${order} asc${suffix}`,
    ...sql.statement("").values,
  );
  return rows.map((value) => {
    let row: BundleEventRow;
    try {
      row = parsePrismaBundleEventRow(value);
      assertInsightsEventContract(row);
    } catch {
      const eventId =
        typeof value === "object" &&
        value !== null &&
        typeof Reflect.get(value, "id") === "string"
          ? Reflect.get(value, "id")
          : "unknown";
      throw new PrismaInsightsMigrationPoisonError(eventId);
    }
    return row;
  });
};

export interface PrismaInsightsMaintenanceStepInput {
  readonly maxItems: number;
  readonly maxRequests: number;
}

export interface PrismaInsightsMaintenanceStepResult {
  readonly processed: number;
  readonly ready: boolean;
  readonly requestsBudget: number;
}

export const preparePrismaInsights = async (
  client: PrismaInsightsClient,
  provider: ORMSQLProvider,
  databaseNamespace: string,
  input: { readonly writersDrained: true },
): Promise<{ readonly ready: boolean }> => {
  if (input.writersDrained !== true) {
    throw new DatabasePluginInputError("invalid-operation");
  }
  await createPrismaInsightsLayout(client, provider, databaseNamespace);
  if (
    !(await hasCompletePrismaInsightsLayout(
      client,
      provider,
      databaseNamespace,
    ))
  )
    throw new DatabasePluginInputError("invalid-result");
  return runPrismaInsightsTransaction(client, provider, async (transaction) => {
    const state = await readMigrationState(transaction, provider);
    if (state.failed_reason !== null) return { ready: false };
    if (isTrue(state.migration_initialized))
      return { ready: isTrue(state.ready) };
    const upperId = await readLegacyUpperId(transaction, provider);
    const changed = await executePrismaInsights(
      transaction,
      initializeStatement(provider, upperId),
    );
    if (changed !== 1) {
      throw new DatabasePluginInputError("invalid-result");
    }
    return { ready: upperId === null };
  });
};

export const createPrismaInsightsMaintenance = (
  client: PrismaInsightsClient,
  provider: ORMSQLProvider,
  databaseNamespace: string,
) => {
  assertPrismaInsightsDatabaseNamespace(databaseNamespace);
  return {
    async runStep(
      input: PrismaInsightsMaintenanceStepInput,
    ): Promise<PrismaInsightsMaintenanceStepResult> {
      if (
        !Number.isSafeInteger(input.maxItems) ||
        input.maxItems < 1 ||
        input.maxItems > INSIGHTS_MAINTENANCE_MAX_ITEMS ||
        !Number.isSafeInteger(input.maxRequests) ||
        input.maxRequests < 1 ||
        input.maxRequests > INSIGHTS_MAINTENANCE_MAX_REQUESTS
      ) {
        throw new DatabasePluginInputError("invalid-query");
      }
      // State/page/checkpoint, bounded identity preflights, source allocation,
      // chunked event/live/alias writes and poison diagnostics are fixed. Only
      // existing live rows can add one fenced update per item.
      // Prisma's MySQL and SQL Server interactive transactions have a fixed
      // 60 second timeout. Keep their native write batches below the measured
      // safe ceiling even when the caller offers the cross-dialect maximum.
      const capacity = Math.min(
        input.maxItems,
        Math.max(0, input.maxRequests - 14),
        200,
        provider === "mysql" || provider === "mssql" ? 50 : 200,
      );
      try {
        return await runPrismaInsightsTransaction(
          client,
          provider,
          async (transaction) => {
            await readPrismaInsightsState(transaction, databaseNamespace);
            const state = await readMigrationState(transaction, provider);
            if (state.failed_reason !== null) {
              throw new PrismaInsightsMigrationPoisonError(
                state.failed_reason.split(":").at(-1) ?? "unknown",
              );
            }
            if (isTrue(state.ready)) {
              return {
                processed: 0,
                ready: true,
                requestsBudget: input.maxRequests,
              };
            }
            if (!isTrue(state.migration_initialized)) {
              throw new DatabasePluginInputError("invalid-operation");
            }
            if (capacity === 0) {
              return {
                processed: 0,
                ready: false,
                requestsBudget: input.maxRequests,
              };
            }
            const candidateCount = await readLegacyCandidateCount(
              transaction,
              provider,
              state,
              capacity,
            );
            const candidates = await readLegacyPage(
              transaction,
              provider,
              state,
              candidateCount,
            );
            if (candidateCount > 0 && candidates.length !== candidateCount)
              throw new DatabasePluginInputError("invalid-result");
            const rows: BundleEventRow[] = [];
            for (const row of candidates) {
              if (
                getCanonicalInsightsJsonByteLength([...rows, row]) >
                INSIGHTS_MAINTENANCE_INPUT_MAX_BYTES
              )
                break;
              rows.push(row);
            }
            if (rows.length > 0) {
              await backfillPrismaInsightsEvents(transaction, provider, rows);
            }
            const afterId = rows.at(-1)?.id ?? state.migration_after_id;
            if (afterId === null) {
              throw new DatabasePluginInputError("invalid-result");
            }
            const ready =
              rows.length === candidates.length &&
              (candidates.length < capacity ||
                afterId === state.migration_upper_id);
            const changed = await executePrismaInsights(
              transaction,
              checkpointStatement(provider, afterId, ready),
            );
            if (changed !== 1) {
              throw new DatabasePluginInputError("invalid-result");
            }
            return {
              processed: rows.length,
              ready,
              requestsBudget: input.maxRequests,
            };
          },
        );
      } catch (error) {
        if (error instanceof PrismaInsightsMigrationPoisonError) {
          await markPoison(client, provider, error.eventId);
        }
        throw error;
      }
    },
  };
};
