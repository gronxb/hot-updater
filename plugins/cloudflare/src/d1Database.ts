import {
  createKyselyDatabase,
  type RelationMode,
} from "@hot-updater/server/adapters/kysely";
import type { DatabaseAdapterRuntime } from "@hot-updater/server/db";
import type { Dialect } from "kysely";

export interface D1DatabaseConfig {
  readonly dialect: Dialect;
  readonly relationMode?: RelationMode;
}

export type D1DatabaseRuntime = DatabaseAdapterRuntime;

export const d1Database = (config: D1DatabaseConfig): D1DatabaseRuntime =>
  createKyselyDatabase({
    dialect: config.dialect,
    provider: "sqlite",
    transactionMode: "disabled",
    ...(config.relationMode ? { relationMode: config.relationMode } : {}),
  });
