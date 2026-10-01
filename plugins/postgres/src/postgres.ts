import type { EngineDatabase } from "@hot-updater/plugin-core";
import {
  createEngineDatabase,
  createSqlAdapter,
} from "@hot-updater/plugin-core";
import { kyselyExecutor } from "@hot-updater/server/adapters/kysely";
import { Kysely, PostgresDialect, type Dialect } from "kysely";
import pg, { type PoolConfig } from "pg";

const { Pool } = pg;

export type PostgresConfig = PoolConfig & {
  readonly dialect?: Dialect;
};

/**
 * Hot Updater's database on PostgreSQL, through a `pg` pool or the given
 * Kysely dialect. Before first use, apply `sql/bundles.sql`, core's tables,
 * and add the tables of the server's plugins with `hot-updater db migrate`;
 * the schema fence refuses a database without their settings rows.
 */
export const postgres = (config: PostgresConfig): EngineDatabase => {
  const { dialect, ...poolConfig } = config;
  const db = new Kysely<object>({
    dialect: dialect ?? new PostgresDialect({ pool: new Pool(poolConfig) }),
  });
  return {
    ...createEngineDatabase({
      name: "postgres",
      adapter: createSqlAdapter({ executor: kyselyExecutor(db, "postgresql") }),
    }),
    dispose: () => db.destroy(),
  };
};
