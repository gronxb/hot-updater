import path from "node:path";
import { fileURLToPath } from "node:url";

import { setupDatabaseAdapterConformanceSuite } from "@hot-updater/test-utils";
import { assertDockerComposeAvailable } from "@hot-updater/test-utils/node";
import { execa } from "execa";
import mysql from "mysql2/promise";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createBundleRowFixture,
  createChannelRowFixture,
  createReleaseRowFixture,
} from "../../../../test-utils/src/databaseTestFixtures";
import {
  createLegacyDatabasePlugin,
  migrateLegacyFacade,
} from "../legacyFacade";
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

/** The whole schema the façade spans, migrated and fenced on each server. */
describe.each([
  ["PostgreSQL", () => pgExecutor(postgres)],
  ["MySQL", () => mysqlExecutor(mariadb)],
] as const)("the façade's schema on pooled %s", (name, executor) => {
  it("migrates, passes the fence, and commits a release with its long scope key", async () => {
    tests += 1;
    const adapter = createSqlAdapter({
      executor: executor(),
      tablePrefix: `f${tests}_`,
    });
    await migrateLegacyFacade(adapter, name);
    await migrateLegacyFacade(adapter, name);
    const database = createLegacyDatabasePlugin({ name, adapter, fence: true });
    const channel = createChannelRowFixture("x".repeat(255));
    const bundle = createBundleRowFixture("901");
    const release = {
      ...createReleaseRowFixture("901", bundle, channel),
      scope_key: `v1:app-version:ios:${"k".repeat(1400)}`,
    };
    await database.models.channels.insert({
      row: channel,
      onConflict: "returnExisting",
    });
    await expect(
      database.commit({
        changes: [
          { model: "bundles", operation: "insert", row: bundle },
          { model: "releases", operation: "insert", row: release },
        ],
      }),
    ).resolves.toEqual({ committed: true });
    await expect(
      database.models.releases.findManyByScope({
        scopeKey: release.scope_key,
        limit: 10,
        consistency: "strong",
      }),
    ).resolves.toEqual([release]);
  });
});
