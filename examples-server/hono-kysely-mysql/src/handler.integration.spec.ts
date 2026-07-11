import path from "path";
import { fileURLToPath } from "url";

import type { Bundle } from "@hot-updater/core";
import type { HotUpdaterAPI } from "@hot-updater/server";
import { kyselyDatabase } from "@hot-updater/server/adapters/kysely";
import {
  setupBundleEventPersistenceTest,
  setupBundleMethodsTestSuite,
  setupGetUpdateInfoTestSuite,
} from "@hot-updater/test-utils";
import {
  assertDockerComposeAvailable,
  cleanupServer,
  createGetUpdateInfo,
  killPort,
  spawnServerProcess,
  waitForServer,
} from "@hot-updater/test-utils/node";
import { execa } from "execa";
import { afterAll, beforeAll, describe } from "vitest";

import { startMySQLTestDatabase } from "./mysqlTestDatabase";

// Get the directory of this test file
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
assertDockerComposeAvailable(
  "Hono + MySQL integration tests require Docker Compose and a running Docker daemon.",
);

describe("Hot Updater Handler Integration Tests (Hono + MySQL)", () => {
  let serverProcess: ReturnType<typeof execa> | null = null;
  let baseUrl: string;
  let hotUpdater: HotUpdaterAPI;
  let eventDatabase: ReturnType<typeof kyselyDatabase>;
  let closeDatabase: (() => Promise<void>) | null = null;
  let countEventRows: () => Promise<number>;
  let countEventRowsById: (id: string) => Promise<number>;
  let mysqlTestDatabase: Awaited<
    ReturnType<typeof startMySQLTestDatabase>
  > | null = null;
  const port = 13579;

  beforeAll(async () => {
    // Kill any process using the port before starting
    await killPort(port);

    baseUrl = `http://localhost:${port}`;

    mysqlTestDatabase = await startMySQLTestDatabase(projectRoot);

    const db = await import("./db.js");
    const { createMigrator } = await import("@hot-updater/server/db");
    const migrator = createMigrator(db.hotUpdater);
    const result = await migrator.migrateToLatest({
      mode: "from-schema",
      updateSettings: true,
    });
    await result.execute();

    hotUpdater = db.hotUpdater;
    eventDatabase = kyselyDatabase({ db: db.kysely, provider: "mysql" });
    closeDatabase = db.closeDatabase;
    countEventRows = async () => {
      const row = await db.kysely
        .selectFrom("bundle_events")
        .select(({ fn }) => fn.countAll().as("count"))
        .executeTakeFirstOrThrow();
      return Number(row.count);
    };
    countEventRowsById = async (id) => {
      const row = await db.kysely
        .selectFrom("bundle_events")
        .select(({ fn }) => fn.countAll().as("count"))
        .where("id", "=", id)
        .executeTakeFirstOrThrow();
      return Number(row.count);
    };

    serverProcess = spawnServerProcess({
      serverCommand: ["npx", "tsx", "src/index.ts"],
      port,
      testDbPath: "", // Not needed for MySQL
      projectRoot,
      env: { MYSQL_DATABASE: mysqlTestDatabase.databaseName },
    });

    await waitForServer(baseUrl, 180); // 180 attempts * 200ms = 36 seconds
  }, 120000);

  afterAll(async () => {
    try {
      await cleanupServer(baseUrl, serverProcess, "");
    } finally {
      try {
        await closeDatabase?.();
      } finally {
        await mysqlTestDatabase?.restore();
      }
    }
  }, 60000);

  const getUpdateInfo: ReturnType<typeof createGetUpdateInfo> = (
    bundles,
    options,
  ) => {
    return createGetUpdateInfo({
      baseUrl: `${baseUrl}/hot-updater`,
    })(bundles, options);
  };

  setupGetUpdateInfoTestSuite({ getUpdateInfo });

  setupBundleMethodsTestSuite({
    getBundleById: (id: string) => hotUpdater.getBundleById(id),
    getChannels: () => hotUpdater.getChannels(),
    insertBundle: (bundle: Bundle) => hotUpdater.insertBundle(bundle),
    getBundles: (options) => hotUpdater.getBundles(options),
    updateBundleById: (bundleId: string, newBundle: Partial<Bundle>) =>
      hotUpdater.updateBundleById(bundleId, newBundle),
    deleteBundleById: (bundleId: string) =>
      hotUpdater.deleteBundleById(bundleId),
  });

  setupBundleEventPersistenceTest({
    getRuntime: () => eventDatabase,
    countEventRows: () => countEventRows(),
    countEventRowsById: (id) => countEventRowsById(id),
  });
});
