import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { PGlite } from "@electric-sql/pglite";
import {
  createEngineSqlMigrator,
  type SqlExecutor,
  toolingTargetOf,
} from "@hot-updater/plugin-core";
import {
  assertDockerComposeAvailable,
  mysqlExecutor,
  pgliteExecutor,
  sqliteExecutor,
} from "@hot-updater/test-utils/node";
import { execa } from "execa";
import mysql from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { insights } from "../../plugins";

assertDockerComposeAvailable(
  "SQL migration tests need Docker Compose and a running Docker daemon.",
);

const compose = [
  "compose",
  "-f",
  path.join(import.meta.dirname, "docker-compose.yml"),
  "-p",
  "hot-updater-sql-migrator",
];

const MYSQL_URI = "mysql://root:hot_updater@127.0.0.1:53306/hot_updater";

let pool: mysql.Pool;

beforeAll(async () => {
  await execa("docker", [...compose, "up", "-d", "--wait", "mysql"]);
  pool = mysql.createPool({ uri: MYSQL_URI, connectionLimit: 4 });
  for (let attempt = 0; ; attempt += 1) {
    try {
      await pool.query("SELECT 1");
      break;
    } catch (error) {
      if (attempt > 60) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await execa("docker", [...compose, "down", "-v"]);
}, 60_000);

/** An index 1.2 adds to a table 1.0 already created. */
const INDEX = "bundle_events__byBundle__key";

/** A database's names for the indexes on `bundle_events__byBundle`. */
const indexesOf: Record<
  SqlExecutor["dialect"],
  (executor: SqlExecutor) => Promise<string[]>
> = {
  sqlite: async (executor) =>
    (
      await executor.execute({
        sql: "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'bundle_events__byBundle'",
        params: [],
      })
    ).rows.map(({ name }) => String(name)),
  postgresql: async (executor) =>
    (
      await executor.execute({
        sql: "SELECT indexname FROM pg_indexes WHERE tablename = 'bundle_events__byBundle'",
        params: [],
      })
    ).rows.map(({ indexname }) => String(indexname)),
  mysql: async (executor) =>
    (
      await executor.execute({
        sql: "SELECT DISTINCT index_name AS name FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'bundle_events__byBundle'",
        params: [],
      })
    ).rows.map(({ name }) => String(name)),
};

const dropIndex: Record<SqlExecutor["dialect"], string> = {
  sqlite: `DROP INDEX "${INDEX}"`,
  postgresql: `DROP INDEX "${INDEX}"`,
  mysql: `DROP INDEX \`${INDEX}\` ON \`bundle_events__byBundle\``,
};

const schemaCore: Record<SqlExecutor["dialect"], string> = {
  sqlite: `UPDATE "private_hot_updater_settings" SET "value" = '1.0.0' WHERE "key" = 'schema.core'`,
  postgresql: `UPDATE "private_hot_updater_settings" SET "value" = '1.0.0' WHERE "key" = 'schema.core'`,
  mysql:
    "UPDATE `private_hot_updater_settings` SET `value` = '1.0.0' WHERE `key` = 'schema.core'",
};

describe("hot-updater db migrate on SQL", () => {
  const executors: readonly [string, () => Promise<SqlExecutor>][] = [
    ["SQLite", async () => sqliteExecutor(new DatabaseSync(":memory:"))],
    ["PGlite", async () => pgliteExecutor(new PGlite())],
    ["MySQL", async () => mysqlExecutor(pool)],
  ];

  it.each(executors)(
    "adds an index to a table an earlier release created, on %s",
    async (_, open) => {
      const executor = await open();
      const { schema, settings } = toolingTargetOf([insights()]);
      const migrate = async () => {
        const migrator = createEngineSqlMigrator({
          adapterName: "test",
          executor,
          schema,
          settings,
        });
        await (await migrator.up()).execute();
      };
      await migrate();
      expect(await indexesOf[executor.dialect](executor)).toContain(INDEX);

      // A 1.0 database: the index table without the index, on 1.0's settings.
      await executor.execute({ sql: dropIndex[executor.dialect], params: [] });
      await executor.execute({ sql: schemaCore[executor.dialect], params: [] });
      expect(await indexesOf[executor.dialect](executor)).not.toContain(INDEX);

      await migrate();
      expect(await indexesOf[executor.dialect](executor)).toContain(INDEX);
    },
    120_000,
  );
});
