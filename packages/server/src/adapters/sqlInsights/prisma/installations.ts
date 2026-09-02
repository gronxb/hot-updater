import {
  DatabasePluginInputError,
  type InsightsInstallationRow,
  type InsightsLiveInstallationPage,
  type InsightsLiveInstallationPageInput,
} from "@hot-updater/plugin-core";

import type { ORMSQLProvider } from "../../../db/types";
import {
  PrismaInsightsSql,
  queryPrismaInsights,
  type PrismaInsightsRawClient,
  type PrismaInsightsStatement,
} from "./client";
import {
  assertPrismaInsightsLimit,
  assertPrismaInsightsQuery,
  assertPrismaInsightsString,
  createPrismaInsightsInstallationCursor,
  parsePrismaInsightsEventJson,
  prismaInsightsEventOrder,
  prismaInsightsInstallKey,
  readPrismaInsightsInstallationCursor,
  takePrismaInsightsPageRows,
  toPrismaInsightsInstallationRow,
  validatedPrismaInsightsPageResult,
} from "./codec";
import { PRISMA_INSIGHTS_LIVE } from "./schema";
import { prismaInsightsVersions, readReadyPrismaInsightsState } from "./source";
import { prismaInsightsSourceGeneration } from "./utils";

type StoredLive = {
  install_key: Uint8Array;
  install_id: string;
  event_id: string;
  received_at_ms: number;
  event_order: Uint8Array;
  source_generation: bigint | number | string;
  event_json: string;
};

const currentTimeStatement = (provider: ORMSQLProvider): string => {
  switch (provider) {
    case "postgresql":
    case "cockroachdb":
      return "select floor(extract(epoch from statement_timestamp())*1000)::float8 as observed_at_ms";
    case "mysql":
      return "select floor(unix_timestamp(current_timestamp(3))*1000) as observed_at_ms";
    case "sqlite":
      return "select cast(round((julianday('now')-2440587.5)*86400000) as integer) as observed_at_ms";
    case "mssql":
      return "select datediff_big(millisecond,'1970-01-01',sysutcdatetime()) as observed_at_ms";
  }
};

const readObservedAtMs = async (
  client: PrismaInsightsRawClient,
  provider: ORMSQLProvider,
): Promise<number> => {
  const rows = await client.$queryRawUnsafe<
    { readonly observed_at_ms: bigint | number | string }[]
  >(currentTimeStatement(provider));
  const value = rows[0]?.observed_at_ms;
  const observedAtMs =
    typeof value === "bigint" ? Number(value) : Number(value);
  if (!Number.isSafeInteger(observedAtMs) || observedAtMs < 0) {
    throw new DatabasePluginInputError("invalid-result");
  }
  return observedAtMs;
};

const pageStatement = (
  provider: ORMSQLProvider,
  input: InsightsLiveInstallationPageInput,
): PrismaInsightsStatement => {
  const sql = new PrismaInsightsSql(provider);
  const conditions: string[] = [];
  if (input.kind === "installationId") {
    conditions.push(
      `install_key=${sql.value(prismaInsightsInstallKey(input.installId))}`,
    );
  } else {
    const cursor = readPrismaInsightsInstallationCursor(input);
    if (cursor !== undefined) {
      conditions.push(`install_key>${sql.value(cursor.installKey)}`);
    }
  }
  const limit = sql.value(
    input.kind === "installationId" ? 1 : input.limit + 1,
  );
  const top = provider === "mssql" ? `top (${limit}) ` : "";
  const suffix = provider === "mssql" ? "" : ` limit ${limit}`;
  return sql.statement(
    `select ${top}install_key,install_id,event_id,received_at_ms,event_order,
      source_generation,event_json from ${PRISMA_INSIGHTS_LIVE}
      ${conditions.length === 0 ? "" : `where ${conditions.join(" and ")}`}
      order by install_key asc${suffix}`,
  );
};

const readStored = (
  row: StoredLive,
): { readonly key: Buffer; readonly event: InsightsInstallationRow } => {
  const raw = parsePrismaInsightsEventJson(row.event_json);
  const key = Buffer.from(row.install_key);
  if (
    !key.equals(prismaInsightsInstallKey(row.install_id)) ||
    raw.install_id !== row.install_id ||
    raw.id !== row.event_id ||
    raw.received_at_ms !== row.received_at_ms ||
    !Buffer.from(row.event_order).equals(prismaInsightsEventOrder(row.event_id))
  ) {
    throw new DatabasePluginInputError("invalid-result");
  }
  const sourceGeneration =
    typeof row.source_generation === "bigint"
      ? row.source_generation
      : BigInt(row.source_generation);
  if (sourceGeneration < 1n) {
    throw new DatabasePluginInputError("invalid-result");
  }
  return { key, event: toPrismaInsightsInstallationRow(raw) };
};

const assertInput = (input: InsightsLiveInstallationPageInput): void => {
  assertPrismaInsightsQuery(input);
  assertPrismaInsightsLimit(input.limit);
  if (input.kind === "installationId") {
    if (
      Object.keys(input).some(
        (key) => !["kind", "installId", "limit"].includes(key),
      )
    ) {
      throw new DatabasePluginInputError("invalid-query");
    }
    assertPrismaInsightsString(input.installId, true);
    return;
  }
  if (
    Object.keys(input).some((key) => !["kind", "cursor", "limit"].includes(key))
  ) {
    throw new DatabasePluginInputError("invalid-query");
  }
  readPrismaInsightsInstallationCursor(input);
};

export const createPrismaInsightsInstallationPages = (
  client: PrismaInsightsRawClient,
  provider: ORMSQLProvider,
  databaseNamespace: string,
) => ({
  async pageInstallations(
    input: InsightsLiveInstallationPageInput,
  ): Promise<InsightsLiveInstallationPage> {
    assertInput(input);
    const state = await readReadyPrismaInsightsState(
      client,
      provider,
      databaseNamespace,
    );
    if ("state" in state)
      return validatedPrismaInsightsPageResult(state, input.limit);
    if (input.kind === "all") {
      const cursor = readPrismaInsightsInstallationCursor(input);
      if (cursor !== undefined && cursor.sourceId !== state.sourceId)
        throw new DatabasePluginInputError("invalid-query");
    }
    const stored = await queryPrismaInsights<StoredLive[]>(
      client,
      pageStatement(provider, input),
    );
    const observedAtMs = await readObservedAtMs(client, provider);
    const rows = stored.map(readStored);
    if (
      input.kind === "installationId" &&
      rows.some(({ event }) => event.install_id !== input.installId)
    ) {
      throw new DatabasePluginInputError("invalid-result");
    }
    const projectionGeneration = prismaInsightsSourceGeneration(
      state.generation,
    );
    const versions = prismaInsightsVersions(state, projectionGeneration);
    const makeData = (
      data: readonly InsightsInstallationRow[],
      nextCursor: string | null,
    ) => ({
      data,
      nextCursor,
      hasNext: nextCursor !== null,
      consistency: {
        kind: "live" as const,
        cutoff: {
          kind: "projection" as const,
          observedAtMs,
          projectionGeneration,
        },
      },
      total: { state: "unavailable" as const },
    });
    const candidates = rows.map(({ event }) => event);
    const keys = new Map(rows.map(({ key, event }) => [event.id, key]));
    const page = takePrismaInsightsPageRows(
      candidates,
      input.kind === "installationId" ? 1 : input.limit,
      (data, nextCursor) => ({
        state: "ready",
        versions,
        data: makeData(data, nextCursor),
      }),
      (row) => {
        const key = keys.get(row.id);
        if (key === undefined) {
          throw new DatabasePluginInputError("invalid-result");
        }
        return createPrismaInsightsInstallationCursor(state.sourceId, key);
      },
    );
    const result: InsightsLiveInstallationPage = {
      state: "ready",
      versions,
      data: makeData(page.rows, page.nextCursor),
    };
    return validatedPrismaInsightsPageResult(result, input.limit);
  },
});
