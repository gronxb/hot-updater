import {
  createKyselyDatabase,
  type RelationMode,
} from "@hot-updater/server/adapters/kysely";
import type { DatabaseAdapterRuntime } from "@hot-updater/server/db";
import { PostgresDialect } from "kysely";
import pg, { type PoolConfig } from "pg";

export interface PostgresConfig extends PoolConfig {
  readonly relationMode?: RelationMode;
}

export type PostgresDatabaseRuntime = DatabaseAdapterRuntime;

export const postgres = (config: PostgresConfig): PostgresDatabaseRuntime => {
  const { relationMode, ...poolConfig } = config;
  const { Pool } = pg;
  const pool = new Pool(poolConfig);

  return createKyselyDatabase({
    dialect: new PostgresDialect({ pool }),
    provider: "postgresql",
    ...(relationMode ? { relationMode } : {}),
  });
};
