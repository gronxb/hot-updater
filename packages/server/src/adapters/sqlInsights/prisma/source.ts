import {
  DatabasePluginInputError,
  type BundleEventRow,
  type InsightsFailedRead,
  type InsightsPageEventsInput,
  type InsightsPageEventsResult,
} from "@hot-updater/plugin-core";

import type { ORMSQLProvider } from "../../../db/types";
import {
  PrismaInsightsSql,
  PrismaInsightsConfigurationError,
  queryPrismaInsights,
  type PrismaInsightsRawClient,
  type PrismaInsightsStatement,
} from "./client";
import {
  createPrismaInsightsEventCursor,
  parsePrismaInsightsEventJson,
  prismaInsightsEventOrder,
  prismaInsightsInstallKey,
  readPrismaInsightsEventCursor,
  takePrismaInsightsPageRows,
  type PrismaInsightsEventCursor,
  validatedPrismaInsightsPageResult,
} from "./codec";
import {
  PRISMA_INSIGHTS_EVENTS,
  PRISMA_INSIGHTS_LAYOUT_VERSION,
  PRISMA_INSIGHTS_SOURCE,
  PRISMA_INSIGHTS_STATE,
  hasCompletePrismaInsightsLayout,
} from "./schema";
import {
  assertPrismaInsightsDatabaseNamespace,
  prismaInsightsReadVersions,
  prismaInsightsSafeInteger,
} from "./utils";

type StateRow = {
  layout_version: unknown;
  ready: boolean | number;
  failed_reason: string | null;
  source_id: unknown;
  generation: bigint | number | string;
};

export interface PrismaInsightsState {
  readonly ready: boolean;
  readonly failedReason: string | null;
  readonly sourceId: string;
  readonly generation: number;
}

export const readPrismaInsightsState = async (
  client: PrismaInsightsRawClient,
  databaseNamespace: string,
): Promise<PrismaInsightsState> => {
  assertPrismaInsightsDatabaseNamespace(databaseNamespace);
  const rows = await client.$queryRawUnsafe<StateRow[]>(
    `select state.layout_version,state.ready,state.failed_reason,
      source.source_id,source.generation
      from ${PRISMA_INSIGHTS_STATE} state
      cross join ${PRISMA_INSIGHTS_SOURCE} source
      where state.id=1 and source.id=1`,
  );
  const row = rows[0];
  if (
    row === undefined ||
    prismaInsightsSafeInteger(row.layout_version) !==
      PRISMA_INSIGHTS_LAYOUT_VERSION ||
    typeof row.source_id !== "string" ||
    (row.failed_reason !== null && typeof row.failed_reason !== "string")
  ) {
    throw new DatabasePluginInputError("invalid-result");
  }
  if (row.source_id !== databaseNamespace) {
    throw new PrismaInsightsConfigurationError(
      "Prisma Insights database namespace mismatch",
    );
  }
  return {
    ready: row.ready === true || row.ready === 1,
    failedReason: row.failed_reason,
    sourceId: row.source_id,
    generation: prismaInsightsSafeInteger(row.generation),
  };
};

export const prismaInsightsVersions = <TProjection extends string | null>(
  state: PrismaInsightsState,
  projectionGeneration: TProjection,
) => prismaInsightsReadVersions(state.generation, projectionGeneration);

const failedRead = (
  state: PrismaInsightsState | undefined,
  code:
    | "schema-not-ready"
    | "storage-not-ready"
    | "source-not-ready"
    | "migration-poison",
): InsightsFailedRead => ({
  state: "failed",
  versions:
    state === undefined
      ? {
          schemaVersion: null,
          storageVersion: null,
          projectionGeneration: null,
          sourceGeneration: null,
        }
      : prismaInsightsVersions(state, null),
  error:
    code === "migration-poison"
      ? { code, jobId: "prisma-insights-migration" }
      : { code },
});

export const readReadyPrismaInsightsState = async (
  client: PrismaInsightsRawClient,
  provider: ORMSQLProvider,
  databaseNamespace: string,
): Promise<PrismaInsightsState | InsightsFailedRead> => {
  assertPrismaInsightsDatabaseNamespace(databaseNamespace);
  let state: PrismaInsightsState;
  try {
    state = await readPrismaInsightsState(client, databaseNamespace);
  } catch (error) {
    if (error instanceof PrismaInsightsConfigurationError) throw error;
    return failedRead(undefined, "schema-not-ready");
  }
  if (state.failedReason !== null) return failedRead(state, "migration-poison");
  if (!state.ready) return failedRead(state, "source-not-ready");
  try {
    if (
      !(await hasCompletePrismaInsightsLayout(
        client,
        provider,
        databaseNamespace,
      ))
    )
      return failedRead(state, "storage-not-ready");
  } catch {
    return failedRead(state, "storage-not-ready");
  }
  return state;
};

type StoredEvent = {
  event_id: string;
  received_at_ms: number;
  event_order: Uint8Array;
  install_key: Uint8Array;
  install_id: string;
  event_json: string;
};

type EventStream =
  | { readonly kind: "all" }
  | {
      readonly kind: "installation";
      readonly installKey: Buffer;
      readonly installId: string;
      readonly type: "UPDATE_APPLIED" | "RECOVERED";
    }
  | {
      readonly kind: "bundle";
      readonly field: "to_bundle_id" | "from_bundle_id";
      readonly bundleId: string;
      readonly type: "UPDATE_APPLIED" | "RECOVERED";
    };

const streamsFor = (input: InsightsPageEventsInput): readonly EventStream[] => {
  switch (input.selector.kind) {
    case "all":
      return [{ kind: "all" }];
    case "installationId": {
      const installId = input.selector.installId;
      const installKey = prismaInsightsInstallKey(installId);
      return (["UPDATE_APPLIED", "RECOVERED"] as const).map((type) => ({
        kind: "installation" as const,
        installKey,
        installId,
        type,
      }));
    }
    case "bundleId":
      return [
        {
          kind: "bundle",
          field: "to_bundle_id",
          bundleId: input.selector.bundleId,
          type: "UPDATE_APPLIED",
        },
        {
          kind: "bundle",
          field: "from_bundle_id",
          bundleId: input.selector.bundleId,
          type: "RECOVERED",
        },
      ];
  }
};

const selectStatement = (
  provider: ORMSQLProvider,
  stream: EventStream,
  input: InsightsPageEventsInput,
  range:
    | { readonly kind: "initial" }
    | { readonly kind: "tie"; readonly cursor: PrismaInsightsEventCursor }
    | { readonly kind: "older"; readonly cursor: PrismaInsightsEventCursor },
  limit: number,
): PrismaInsightsStatement => {
  const sql = new PrismaInsightsSql(provider);
  const conditions: string[] = [];
  if (stream.kind === "installation") {
    conditions.push(`install_key = ${sql.value(stream.installKey)}`);
    conditions.push(`type = ${sql.value(stream.type)}`);
  } else if (stream.kind === "bundle") {
    conditions.push(`type = ${sql.value(stream.type)}`);
    conditions.push(`${stream.field} = ${sql.value(stream.bundleId)}`);
  }
  conditions.push(
    `received_at_ms >= ${sql.value(input.sinceReceivedAtMs ?? 0)}`,
    `received_at_ms < ${sql.value(input.beforeReceivedAtMs)}`,
  );
  if (range.kind === "tie") {
    conditions.push(`received_at_ms = ${sql.value(range.cursor.receivedAtMs)}`);
    conditions.push(
      `event_order < ${sql.value(prismaInsightsEventOrder(range.cursor.id))}`,
    );
  } else if (range.kind === "older") {
    conditions.push(`received_at_ms < ${sql.value(range.cursor.receivedAtMs)}`);
  }
  const limitValue = sql.value(limit);
  const top = provider === "mssql" ? `top (${limitValue}) ` : "";
  const suffix = provider === "mssql" ? "" : ` limit ${limitValue}`;
  return sql.statement(`select ${top}event_id,received_at_ms,event_order,
    install_key,install_id,event_json from ${PRISMA_INSIGHTS_EVENTS}
    where ${conditions.join(" and ")}
    order by received_at_ms desc,event_order desc${suffix}`);
};

const verifyStoredEvent = (
  row: StoredEvent,
  stream: EventStream,
): BundleEventRow => {
  const event = parsePrismaInsightsEventJson(row.event_json);
  const eventOrder = Buffer.from(row.event_order);
  const installKey = Buffer.from(row.install_key);
  if (
    row.event_id !== event.id ||
    row.received_at_ms !== event.received_at_ms ||
    !eventOrder.equals(prismaInsightsEventOrder(event.id)) ||
    row.install_id !== event.install_id ||
    !installKey.equals(prismaInsightsInstallKey(event.install_id))
  ) {
    throw new DatabasePluginInputError("invalid-result");
  }
  if (
    (stream.kind === "installation" &&
      (event.install_id !== stream.installId || event.type !== stream.type)) ||
    (stream.kind === "bundle" &&
      (event.type !== stream.type || event[stream.field] !== stream.bundleId))
  ) {
    throw new DatabasePluginInputError("invalid-result");
  }
  return event;
};

const readStream = async (
  client: PrismaInsightsRawClient,
  provider: ORMSQLProvider,
  stream: EventStream,
  input: InsightsPageEventsInput,
  cursor: PrismaInsightsEventCursor | undefined,
  limit: number,
): Promise<readonly BundleEventRow[]> => {
  const read = async (
    range: Parameters<typeof selectStatement>[3],
    requested: number,
  ) => {
    const rows = await queryPrismaInsights<StoredEvent[]>(
      client,
      selectStatement(provider, stream, input, range, requested),
    );
    if (rows.length > requested) {
      throw new DatabasePluginInputError("invalid-result");
    }
    return rows.map((row) => verifyStoredEvent(row, stream));
  };
  if (cursor === undefined) return read({ kind: "initial" }, limit);
  const ties = await read({ kind: "tie", cursor }, limit);
  if (ties.length === limit) return ties;
  const older = await read({ kind: "older", cursor }, limit - ties.length);
  return [...ties, ...older];
};

const compareEvents = (left: BundleEventRow, right: BundleEventRow): number =>
  right.received_at_ms - left.received_at_ms ||
  (left.id < right.id ? 1 : left.id > right.id ? -1 : 0);

export const createPrismaInsightsEventPages = (
  client: PrismaInsightsRawClient,
  provider: ORMSQLProvider,
  databaseNamespace: string,
) => {
  assertPrismaInsightsDatabaseNamespace(databaseNamespace);
  return {
    async pageEvents(
      input: InsightsPageEventsInput,
    ): Promise<InsightsPageEventsResult> {
      const cursor = readPrismaInsightsEventCursor(input);
      if (cursor !== undefined && cursor.sourceId !== databaseNamespace)
        throw new DatabasePluginInputError("invalid-query");
      const state = await readReadyPrismaInsightsState(
        client,
        provider,
        databaseNamespace,
      );
      if ("state" in state)
        return validatedPrismaInsightsPageResult(state, input.limit);
      const streamRows: (readonly BundleEventRow[])[] = [];
      for (const stream of streamsFor(input)) {
        streamRows.push(
          await readStream(
            client,
            provider,
            stream,
            input,
            cursor,
            input.limit + 1,
          ),
        );
      }
      const candidates = streamRows.flat().sort(compareEvents);
      if (new Set(candidates.map(({ id }) => id)).size !== candidates.length) {
        throw new DatabasePluginInputError("invalid-result");
      }
      const versions = prismaInsightsVersions(state, null);
      const makeData = (
        rows: readonly BundleEventRow[],
        nextCursor: string | null,
      ) => ({
        data: rows,
        nextCursor,
        hasNext: nextCursor !== null,
        consistency: {
          kind: "live" as const,
          cutoff: {
            kind: "event-time" as const,
            beforeReceivedAtMs: input.beforeReceivedAtMs,
          },
        },
        total: { state: "unavailable" as const },
      });
      const page = takePrismaInsightsPageRows(
        candidates,
        input.limit,
        (rows, nextCursor) => ({
          state: "ready",
          versions,
          data: makeData(rows, nextCursor),
        }),
        (row) => createPrismaInsightsEventCursor(input, databaseNamespace, row),
      );
      const result: InsightsPageEventsResult = {
        state: "ready",
        versions,
        data: makeData(page.rows, page.nextCursor),
      };
      return validatedPrismaInsightsPageResult(result, input.limit);
    },
  };
};
