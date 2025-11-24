import type { Bundle } from "@hot-updater/core";
import type { HotUpdaterAPI } from "@hot-updater/server";
import {
  setupBundleMethodsTestSuite,
  setupGetUpdateInfoTestSuite,
} from "@hot-updater/test-utils";
import {
  cleanupServer,
  createGetUpdateInfo,
  createTestDbPath,
  killPort,
  spawnServerProcess,
  waitForServer,
} from "@hot-updater/test-utils/node";
import { execa } from "execa";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { afterAll, beforeAll, describe } from "vitest";

// Get the directory of this test file
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

describe("Hot Updater Handler Integration Tests (Hono)", () => {
  let serverProcess: ReturnType<typeof execa> | null = null;
  let baseUrl: string;
  let testDbPath: string;
  let hotUpdater: HotUpdaterAPI;
  const port = 13579;

  beforeAll(async () => {
    // Kill any process using the port before starting
    await killPort(port);

    testDbPath = createTestDbPath(projectRoot);
    await fs.mkdir(path.join(projectRoot, "data"), { recursive: true });

    process.env.TEST_DB_PATH = testDbPath;

    baseUrl = `http://localhost:${port}`;

    // Run database migrations before starting server
    const hotUpdaterPkgPath = require.resolve("hot-updater/package.json");
    const hotUpdaterCli = path.join(
      path.dirname(hotUpdaterPkgPath),
      "dist/index.js",
    );

    // Then apply migrations to database
    await execa(
      "node",
      [hotUpdaterCli, "db", "migrate", "src/db.ts", "--yes"],
      {
        cwd: projectRoot,
        env: { TEST_DB_PATH: testDbPath },
      },
    );

    serverProcess = spawnServerProcess({
      serverCommand: ["npx", "tsx", "src/index.ts"],
      port,
      testDbPath,
      projectRoot,
    });

    await waitForServer(baseUrl, 60); // 60 attempts * 200ms = 12 seconds

    const db = await import("./db.js");
    hotUpdater = db.hotUpdater;
  }, 60000);

  afterAll(async () => {
    await cleanupServer(baseUrl, serverProcess, testDbPath);
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
});
