import { postgres, type PostgresConfig } from "@hot-updater/postgres";
import {
  createKyselyDatabase,
  type RelationMode,
} from "@hot-updater/server/adapters/kysely";
import type { DatabaseAdapterRuntime } from "@hot-updater/server/db";
import type { Dialect } from "kysely";

export type SupabaseDatabaseRuntime = DatabaseAdapterRuntime;

export type SupabaseDialectDatabaseConfig = {
  readonly dialect: Dialect;
  readonly relationMode?: RelationMode;
};

export type SupabaseDatabaseConfig =
  | PostgresConfig
  | SupabaseDialectDatabaseConfig;

export const supabaseDatabase = (
  config: SupabaseDatabaseConfig,
): SupabaseDatabaseRuntime => {
  if ("dialect" in config) {
    return createKyselyDatabase({
      dialect: config.dialect,
      provider: "postgresql",
      ...(config.relationMode ? { relationMode: config.relationMode } : {}),
    });
  }

  return postgres(config);
};
