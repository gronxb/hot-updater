import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  setupDatabaseTestSuite,
  startHttpTestServer,
} from "@hot-updater/test-utils";
import { assertDockerComposeAvailable } from "@hot-updater/test-utils/node";
import { execa } from "execa";
import mysql from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabasePluginApis } from "../assembly/databasePlugins";
import { builtInSchema } from "../database/builtInDatabase";
import { isMultiIndex, quoteSql } from "../database/sql/sqlSchema";
import { createHotUpdater } from "../index";
import { createInsightsModel, insights } from "../plugins/insights";
import { prismaAdapter } from "./prisma";
import { mysqlPrisma, prismaPushSql } from "./prismaTestClients";

assertDockerComposeAvailable(
  "Prisma's MySQL integration tests need Docker Compose and a running Docker daemon.",
);

const compose = [
  "compose",
  "-f",
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "../database/sql/docker-compose.yml",
  ),
  "-p",
  "hot-updater-sql-core",
];
const server = "mysql://root:hot_updater@127.0.0.1:53306";
const database = `prisma_${process.pid}`;

const dataTables = builtInSchema.tables.flatMap((table) => [
  table.name,
  ...table.indexes
    .filter((index) => isMultiIndex(table, index))
    .map((index) => `${table.name}__${index.name}`),
]);

let admin: mysql.Pool;
let pool: mysql.Pool;

/**
 * MySQL has no Prisma example, so the tables come from Prisma's own DDL for
 * the generated models, as `prisma db push` would run it, and the adapter
 * runs over mysql2 through Prisma's raw query API.
 */
beforeAll(async () => {
  await execa("docker", [...compose, "up", "-d", "--wait", "mysql"]);
  admin = mysql.createPool({ uri: server, multipleStatements: true });
  for (let attempt = 0; ; attempt += 1) {
    try {
      await admin.query("SELECT 1");
      break;
    } catch (error) {
      if (attempt > 60) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  await admin.query(
    `DROP DATABASE IF EXISTS ${database}; CREATE DATABASE ${database}`,
  );
  await admin.query(`USE ${database}; ${await prismaPushSql("mysql")}`);
  pool = mysql.createPool({
    uri: `${server}/${database}`,
    connectionLimit: 16,
  });
  const migrator = prismaAdapter({
    prisma: mysqlPrisma(pool),
    provider: "mysql",
  }).createMigrator!();
  await (await migrator.migrateToLatest()).execute();
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await admin?.query(`DROP DATABASE IF EXISTS ${database}`);
  await admin?.end();
  await execa("docker", [...compose, "down", "-v"]);
}, 60_000);

setupDatabaseTestSuite({
  createHttpClient: (options) =>
    startHttpTestServer(
      createHotUpdater({
        ...options,
        plugins: [insights()],
        clientAccess: "public",
      }).handlers,
    ),
  createInsightsModel: (database) =>
    createInsightsModel(
      createDatabasePluginApis(database, [insights()]).insights,
    ),
  name: "prismaAdapter (MySQL, Prisma's tables)",
  migrate: () => undefined,
  createDatabase: () =>
    prismaAdapter({ prisma: mysqlPrisma(pool), provider: "mysql" }),
  reset: async () => {
    for (const table of dataTables) {
      await pool.query(`DELETE FROM ${quoteSql("mysql", table)}`);
    }
  },
  dispose: () => undefined,
});

describe("prismaAdapter on Prisma's MySQL tables", () => {
  it("keeps ASCII keys binary and sets binary UTF-8 collations after Prisma", async () => {
    const [columns] = await pool.query(
      "SELECT TABLE_NAME AS name, COLUMN_NAME AS col, DATA_TYPE AS type, COLLATION_NAME AS collation FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND ((TABLE_NAME = 'releases' AND COLUMN_NAME IN ('scope_key', 'channel_id')) OR (TABLE_NAME = 'channels' AND COLUMN_NAME = 'name')) ORDER BY TABLE_NAME, COLUMN_NAME",
    );
    expect(columns).toEqual([
      {
        name: "channels",
        col: "name",
        type: "varchar",
        collation: "utf8mb4_0900_bin",
      },
      {
        name: "releases",
        col: "channel_id",
        type: "varchar",
        collation: "utf8mb4_0900_bin",
      },
      {
        name: "releases",
        col: "scope_key",
        type: "varbinary",
        collation: null,
      },
    ]);
  });
});
