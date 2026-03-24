import type { Bundle } from "@hot-updater/core";
import type { HotUpdaterAPI } from "@hot-updater/server";
import {
  setupBundleMethodsTestSuite,
  setupGetUpdateInfoTestSuite,
} from "@hot-updater/test-utils";
import {
  cleanupServer,
  createGetUpdateInfo,
  killPort,
  spawnServerProcess,
  waitForServer,
} from "@hot-updater/test-utils/node";
import { execa } from "execa";
import path from "path";
import { fileURLToPath } from "url";
import { afterAll, beforeAll, describe } from "vitest";
import { hasDockerCompose } from "../../../packages/test-utils/src/runtimeProcess";

// Get the directory of this test file
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const runMySqlIntegration =
  process.env["RUN_MYSQL_INTEGRATION"] === "1" && hasDockerCompose();

describe.runIf(runMySqlIntegration)(
  "Hot Updater Handler Integration Tests (Hono + MySQL)",
  () => {
    let serverProcess: ReturnType<typeof execa> | null = null;
    let baseUrl: string;
    let hotUpdater: HotUpdaterAPI;
    let closeDatabase: (() => Promise<void>) | null = null;
    const port = 13579;

    beforeAll(async () => {
      // Kill any process using the port before starting
      await killPort(port);

      baseUrl = `http://localhost:${port}`;

      // Ensure Docker MySQL is running
      console.log("Starting MySQL Docker container...");
      await execa("docker", ["compose", "up", "-d", "--wait"], {
        cwd: projectRoot,
      });

      // Wait for MySQL to be healthy
      console.log("Waiting for MySQL to be ready...");
      await waitForMySQLReady(projectRoot, 30);

      // Additional delay to ensure MySQL is fully stabilized
      console.log("Waiting for MySQL to stabilize...");
      await new Promise((resolve) => setTimeout(resolve, 3000));

      const db = await import("./db.js");
      const migrator = db.hotUpdater.createMigrator();
      const result = await migrator.migrateToLatest({
        mode: "from-schema",
        updateSettings: true,
      });
      await result.execute();

      hotUpdater = db.hotUpdater;
      closeDatabase = db.closeDatabase;

      serverProcess = spawnServerProcess({
        serverCommand: ["npx", "tsx", "src/index.ts"],
        port,
        testDbPath: "", // Not needed for MySQL
        projectRoot,
      });

      await waitForServer(baseUrl, 60); // 60 attempts * 200ms = 12 seconds
    }, 120000); // Increased timeout for Docker startup

    afterAll(async () => {
      await cleanupServer(baseUrl, serverProcess, "");
      await closeDatabase?.();

      // Clean up database after tests
      console.log("Cleaning up test database...");
      await cleanupMySQLDatabase(projectRoot);
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
  },
);

// Helper function to wait for MySQL to be ready
async function waitForMySQLReady(
  projectRoot: string,
  maxAttempts: number,
): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      // Check Docker container health status
      const healthResult = await execa(
        "docker",
        ["inspect", "--format={{.State.Health.Status}}", "hono-kysely-mysql"],
        { cwd: projectRoot },
      );
      if (healthResult.stdout.trim() === "healthy") {
        console.log("MySQL is ready!");
        return;
      }
    } catch {
      // Container not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("MySQL failed to become ready");
}

// Helper function to clean up test database
async function cleanupMySQLDatabase(projectRoot: string): Promise<void> {
  try {
    // Drop and recreate database for clean state
    await execa(
      "docker",
      [
        "compose",
        "exec",
        "-T",
        "mysql",
        "mysql",
        "-uhot_updater",
        "-phot_updater_dev",
        "-e",
        "DROP DATABASE IF EXISTS hot_updater; CREATE DATABASE hot_updater;",
      ],
      { cwd: projectRoot },
    );
  } catch (error) {
    console.error("Error cleaning up database:", error);
  }
}
