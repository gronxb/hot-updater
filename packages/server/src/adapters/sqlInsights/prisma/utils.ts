import { createHash, randomUUID } from "node:crypto";

import {
  DatabasePluginInputError,
  type InsightsPublication,
} from "@hot-updater/plugin-core";
import { canonicalInsightsJson } from "@hot-updater/plugin-core/internal";

import type { ORMSQLProvider } from "../../../db/types";
import type { PrismaInsightsRawClient } from "./client";

const databaseNamespacePattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const assertPrismaInsightsDatabaseNamespace = (value: string): void => {
  if (!databaseNamespacePattern.test(value)) {
    throw new DatabasePluginInputError("invalid-query");
  }
};

export const prismaInsightsDigest = (value: unknown): Buffer =>
  createHash("sha256").update(canonicalInsightsJson(value)).digest();

export const newPrismaInsightsId = (): string => randomUUID();

export const prismaInsightsSafeInteger = (value: unknown): number => {
  const result = typeof value === "bigint" ? Number(value) : Number(value);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new DatabasePluginInputError("invalid-result");
  }
  return result;
};

export const prismaInsightsSourceGeneration = (generation: number): string =>
  canonicalInsightsJson(["prisma-insights-1", generation]);

export const prismaInsightsReadVersions = <TProjection extends string | null>(
  generation: number,
  projectionGeneration: TProjection,
) =>
  ({
    schemaVersion: "1.0.0",
    storageVersion: "prisma-insights-1",
    projectionGeneration,
    sourceGeneration: prismaInsightsSourceGeneration(generation),
  }) as const;

export const prismaInsightsPublication = (input: {
  readonly id: string;
  readonly asOfMs: number;
  readonly completedAtMs: number;
  readonly sourceGeneration: number;
}): InsightsPublication => ({
  id: input.id,
  asOfMs: input.asOfMs,
  completedAtMs: input.completedAtMs,
  sourceGeneration: prismaInsightsSourceGeneration(input.sourceGeneration),
  accuracy: "exact",
});

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

export const readPrismaInsightsDatabaseTime = async (
  client: PrismaInsightsRawClient,
  provider: ORMSQLProvider,
): Promise<number> => {
  const rows = await client.$queryRawUnsafe<
    { readonly observed_at_ms: unknown }[]
  >(currentTimeStatement(provider));
  return prismaInsightsSafeInteger(rows[0]?.observed_at_ms);
};
