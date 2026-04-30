import type { Bundle } from "@hot-updater/core";
import type { HotUpdaterAPI } from "@hot-updater/server";
import {
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
import path from "path";
import { fileURLToPath } from "url";
import { afterAll, beforeAll, describe } from "vitest";

// Get the directory of this test file
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

const waitForPostgresContainer = async () => {
  const deadline = Date.now() + 60_000;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      await execa(
        "docker",
        [
          "exec",
          "hono-prisma-postgres",
          "pg_isready",
          "-h",
          "127.0.0.1",
          "-U",
          "hot_updater",
        ],
        {
          cwd: projectRoot,
        },
      );

      await execa(
        "docker",
        [
          "exec",
          "hono-prisma-postgres",
          "psql",
          "-h",
          "127.0.0.1",
          "-U",
          "hot_updater",
          "-d",
          "hot_updater",
          "-c",
          "SELECT 1;",
        ],
        {
          cwd: projectRoot,
        },
      );

      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  throw new Error(
    `PostgreSQL container did not become ready in time: ${String(lastError)}`,
  );
};

assertDockerComposeAvailable(
  "Hono + Prisma + PostgreSQL integration tests require Docker Compose and a running Docker daemon.",
);

describe(
  "Hot Updater Handler Integration Tests (Hono + Prisma + PostgreSQL)",
  () => {
    let serverProcess: ReturnType<typeof execa> | null = null;
    let baseUrl: string;
    let testDbName: string;
    const port = 13583;
    let hotUpdater: HotUpdaterAPI;

    beforeAll(async () => {
      // Kill any process using the port before starting
      await killPort(port);

      // Generate unique test database name
      testDbName = `hot_updater_test_${Date.now()}`;
      const testDatabaseUrl = `postgresql://hot_updater:hot_updater_dev@localhost:5433/${testDbName}`;

      process.env.TEST_DATABASE_URL = testDatabaseUrl;
      process.env.DATABASE_URL = testDatabaseUrl;

      baseUrl = `http://localhost:${port}`;

      // Ensure Docker Compose is running
      await execa("docker", ["compose", "up", "-d"], {
        cwd: projectRoot,
      });

      await waitForPostgresContainer();

      // Create test database
      await execa(
        "docker",
        [
          "exec",
          "hono-prisma-postgres",
          "psql",
          "-h",
          "127.0.0.1",
          "-U",
          "hot_updater",
          "-c",
          `CREATE DATABASE ${testDbName};`,
        ],
        {
          cwd: projectRoot,
        },
      );

      // Run database migrations before starting server
      const hotUpdaterPkgPath = require.resolve("hot-updater/package.json");
      const hotUpdaterCli = path.join(
        path.dirname(hotUpdaterPkgPath),
        "dist/index.cjs",
      );

      // Generate Prisma schema from hotUpdater instance
      await execa(
        "node",
        [hotUpdaterCli, "db", "generate", "src/db.ts", "--yes"],
        {
          cwd: projectRoot,
          env: { TEST_DATABASE_URL: testDatabaseUrl },
        },
      );

      // Regenerate Prisma Client after hot-updater updates the Prisma schema.
      await execa("npx", ["prisma", "generate"], {
        cwd: projectRoot,
        env: { DATABASE_URL: testDatabaseUrl },
      });

      // Apply schema to database using prisma db push
      await execa("npx", ["prisma", "db", "push", "--skip-generate"], {
        cwd: projectRoot,
        env: { DATABASE_URL: testDatabaseUrl },
      });

      serverProcess = spawnServerProcess({
        serverCommand: ["npx", "tsx", "src/index.ts"],
        port,
        testDbPath: "",
        projectRoot,
        env: { TEST_DATABASE_URL: testDatabaseUrl },
      });

      await waitForServer(baseUrl, 180); // 180 attempts * 200ms = 36 seconds

      const db = await import("./db.js");
      hotUpdater = db.hotUpdater;
    }, 120000);

    afterAll(async () => {
      await cleanupServer(baseUrl, serverProcess, "");

      // Drop test database
      try {
        await execa(
          "docker",
          [
            "exec",
            "hono-prisma-postgres",
            "psql",
            "-h",
            "127.0.0.1",
            "-U",
            "hot_updater",
            "-c",
            `DROP DATABASE IF EXISTS ${testDbName} WITH (FORCE);`,
          ],
          {
            cwd: projectRoot,
          },
        );
      } catch (error) {
        console.error("Failed to drop test database:", error);
      }

      // Stop and remove Docker containers
      await execa("docker", ["compose", "down", "-v"], {
        cwd: projectRoot,
      });
    }, 60000);

    const getUpdateInfo: ReturnType<typeof createGetUpdateInfo> = (
      bundles,
      options,
    ) => {
      return createGetUpdateInfo({
        baseUrl: `${baseUrl}/hot-updater`,
      })(bundles, options);
    };

    setupGetUpdateInfoTestSuite({
      getUpdateInfo,
    });

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
