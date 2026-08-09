import { createKyselyAnalyticsPersistence } from "@hot-updater/analytics/adapters/kysely";
import type { AnalyticsPersistence } from "@hot-updater/analytics/provider";
import type { Kysely } from "kysely";

export function createPostgresAnalyticsPersistence<TDatabase extends object>(
  database: Kysely<TDatabase>,
): AnalyticsPersistence {
  return createKyselyAnalyticsPersistence({
    db: database,
    dialect: "postgresql",
  });
}
