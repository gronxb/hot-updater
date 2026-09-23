import path from "node:path";
import { fileURLToPath } from "node:url";

import { setupDatabaseAdapterConformanceSuite } from "@hot-updater/test-utils";
import { assertDockerComposeAvailable } from "@hot-updater/test-utils/node";
import { execa } from "execa";
import mysql from "mysql2/promise";
import pg from "pg";
import { afterAll, beforeAll } from "vitest";

import { createSqlAdapter, type SqlExecutor } from "./sqlAdapter";
import { mysqlExecutor, pgExecutor } from "./sqlTestExecutors";

assertDockerComposeAvailable(
  "SQL core integration tests need Docker Compose and a running Docker daemon.",
);

const compose = [
  "compose",
  "-f",
  path.join(path.dirname(fileURLToPath(import.meta.url)), "docker-compose.yml"),
  "-p",
  "hot-updater-sql-core",
];

/** Retries `connect` until the server accepts connections. */
const ready = async (connect: () => Promise<unknown>) => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await connect();
      return;
    } catch (error) {
      if (attempt > 60) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
};

let postgres: pg.Pool;
let mariadb: mysql.Pool;

beforeAll(async () => {
  await execa("docker", [...compose, "up", "-d", "--wait"]);
  postgres = new pg.Pool({
    connectionString:
      "postgres://postgres:hot_updater@127.0.0.1:55432/hot_updater",
    max: 16,
  });
  mariadb = mysql.createPool({
    uri: "mysql://root:hot_updater@127.0.0.1:53306/hot_updater",
    connectionLimit: 16,
  });
  await ready(() => postgres.query("SELECT 1"));
  await ready(() => mariadb.query("SELECT 1"));
}, 180_000);

afterAll(async () => {
  await postgres?.end();
  await mariadb?.end();
  await execa("docker", [...compose, "down", "-v"]);
}, 60_000);

let tests = 0;
const suite = (name: string, executor: () => SqlExecutor) =>
  setupDatabaseAdapterConformanceSuite({
    name,
    maxOps: 50,
    createAdapter: async ({ tables }) => {
      tests += 1;
      const adapter = createSqlAdapter({
        executor: executor(),
        tablePrefix: `t${tests}_`,
        maxOps: 50,
      });
      await adapter.migrations?.apply(tables);
      return { adapter };
    },
  });

suite("sql (pooled PostgreSQL)", () => pgExecutor(postgres));
suite("sql (pooled MySQL)", () => mysqlExecutor(mariadb));
