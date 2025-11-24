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

// Get the directory of this test file
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

describe("Hot Updater Handler Integration Tests (Hono + MongoDB)", () => {
  let serverProcess: ReturnType<typeof execa> | null = null;
  let baseUrl: string;
  let testDbName: string;
  let hotUpdater: HotUpdaterAPI;
  const port = 13585;

  beforeAll(async () => {
    // Kill any process using the port before starting
    await killPort(port);

    // Generate unique test database name
    testDbName = `hot_updater_test_${Date.now()}`;
    const testMongoUrl = `mongodb://hot_updater:hot_updater_dev@localhost:27018/${testDbName}?authSource=admin`;

    process.env.TEST_MONGODB_URL = testMongoUrl;

    baseUrl = `http://localhost:${port}`;

    // Ensure Docker Compose is running
    await execa("docker", ["compose", "up", "-d"], {
      cwd: projectRoot,
    });

    // Wait for MongoDB to be ready
    await new Promise((resolve) => setTimeout(resolve, 5000));

    // Run database migrations
    const hotUpdaterPkgPath = require.resolve("hot-updater/package.json");
    const hotUpdaterCli = path.join(
      path.dirname(hotUpdaterPkgPath),
      "dist/index.js",
    );

    await execa(
      "node",
      [hotUpdaterCli, "db", "migrate", "src/db.ts", "--yes"],
      {
        cwd: projectRoot,
        env: { TEST_MONGODB_URL: testMongoUrl },
      },
    );

    serverProcess = spawnServerProcess({
      serverCommand: ["npx", "tsx", "src/index.ts"],
      port,
      testDbPath: "",
      projectRoot,
      env: { TEST_MONGODB_URL: testMongoUrl },
    });

    await waitForServer(baseUrl, 60); // 60 attempts * 200ms = 12 seconds

    const db = await import("./db.js");
    hotUpdater = db.hotUpdater;
  }, 120000);

  afterAll(async () => {
    await cleanupServer(baseUrl, serverProcess, "");

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
});
