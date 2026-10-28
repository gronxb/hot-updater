import type { EngineDatabase } from "@hot-updater/plugin-core";
import {
  createEngineDatabase,
  createSqlAdapter,
} from "@hot-updater/plugin-core";
import { kyselyExecutor } from "@hot-updater/server/adapters/kysely";
import { Kysely, PostgresDialect, type Dialect } from "kysely";
import pg, { type PoolConfig } from "pg";

const { Pool } = pg;

/**
 * The resource this database reaches, without credentials, under the key
 * `hot-updater doctor` reads to tell the database `hot-updater init` saved
 * from another (a convention CLAUDE.md documents).
 */
const DATABASE_TARGET = Symbol.for("@hot-updater/database-target");

/** The server and database a pool reaches: `postgres/<host>:<port>/<database>`. */
const targetOf = ({
  connectionString,
  host,
  port,
  database,
}: PostgresPoolConfig): string | undefined => {
  if (typeof connectionString === "function") return undefined;
  if (connectionString !== undefined) {
    try {
      const url = new URL(connectionString);
      return `postgres/${url.hostname}:${url.port || "5432"}/${decodeURIComponent(url.pathname.slice(1))}`;
    } catch {
      return undefined;
    }
  }
  return host === undefined || database === undefined
    ? undefined
    : `postgres/${host}:${port ?? 5432}/${database}`;
};

type PostgresPoolConfig = Omit<PoolConfig, "connectionString"> & {
  /**
   * The database's URL, or a function that returns it, such as one that
   * reads it with `secretEnv`: called when the pool first connects, so a
   * config loads without it.
   */
  readonly connectionString?: string | (() => string | Promise<string>);
};

export type PostgresConfig = PostgresPoolConfig & {
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
  const target = targetOf(poolConfig);
  const { connectionString } = poolConfig;
  const db = new Kysely<object>({
    dialect:
      dialect ??
      new PostgresDialect({
        pool:
          typeof connectionString === "function"
            ? async () =>
                new Pool({
                  ...poolConfig,
                  connectionString: await connectionString(),
                })
            : new Pool({ ...poolConfig, connectionString }),
      }),
  });
  return {
    ...createEngineDatabase({
      name: "postgres",
      adapter: createSqlAdapter({ executor: kyselyExecutor(db, "postgresql") }),
    }),
    ...(target === undefined ? {} : { [DATABASE_TARGET]: target }),
    dispose: () => db.destroy(),
  };
};
