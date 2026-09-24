import path from "node:path";

import {
  mysqlRowsExamined,
  postgresRowsExamined,
  setupReadBudgetTestSuite,
} from "@hot-updater/test-utils";
import { assertDockerComposeAvailable } from "@hot-updater/test-utils/node";
import { execa } from "execa";
import mysql from "mysql2/promise";
import pg from "pg";
import { afterAll, beforeAll } from "vitest";

import { readBudgetServer } from "../../readBudgets.testFixtures";
import { createSqlAdapter } from "./sqlAdapter";
import { mysqlExecutor, pgExecutor } from "./sqlTestExecutors";

assertDockerComposeAvailable(
  "SQL core read-budget tests need Docker Compose and a running Docker daemon.",
);

const compose = [
  "compose",
  "-f",
  path.join(import.meta.dirname, "docker-compose.yml"),
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

/** The SQL core over a pool; reads are explained on one connection of it. */
setupReadBudgetTestSuite({
  name: "sql (pooled PostgreSQL)",
  server: readBudgetServer,
  createAdapter: async ({ tables }) => {
    const session = await postgres.connect();
    const reads = postgresRowsExamined(
      async (sql, params) => (await session.query(sql, [...params])).rows,
    );
    const adapter = createSqlAdapter({
      executor: reads.wrap(pgExecutor(postgres)),
      tablePrefix: "budget_",
    });
    await adapter.migrations!.apply(tables);
    return {
      adapter,
      examined: reads.examined,
      cleanup: async () => session.release(),
    };
  },
});

setupReadBudgetTestSuite({
  name: "sql (pooled MySQL)",
  server: readBudgetServer,
  createAdapter: async ({ tables }) => {
    const session = await mariadb.getConnection();
    const reads = mysqlRowsExamined(
      async (sql, params) =>
        (await session.query(sql, [...params]))[0] as Record<string, unknown>[],
    );
    const adapter = createSqlAdapter({
      executor: reads.wrap(mysqlExecutor(mariadb)),
      tablePrefix: "budget_",
    });
    await adapter.migrations!.apply(tables);
    return {
      adapter,
      examined: reads.examined,
      cleanup: async () => session.release(),
    };
  },
});
