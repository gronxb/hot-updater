import { NIL_UUID, type Bundle } from "@hot-updater/core";
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
  TEST_MANAGEMENT_AUTH_TOKEN,
  waitForServer,
} from "@hot-updater/test-utils/node";
import { execa } from "execa";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Get the directory of this test file
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

describe("Hot Updater Handler Integration Tests (Hono + Drizzle + PGlite)", () => {
  let serverProcess: ReturnType<typeof execa> | null = null;
  let baseUrl: string;
  let testDbPath: string;
  let hotUpdater: HotUpdaterAPI;
  const port = 13582;

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
      "dist/index.mjs",
    );

    // Generate Drizzle schema from hotUpdater instance
    await execa(
      "node",
      [hotUpdaterCli, "db", "generate", "src/db.ts", "--yes"],
      {
        cwd: projectRoot,
        env: { TEST_DB_PATH: testDbPath },
      },
    );

    // Apply schema to database using drizzle-kit
    await execa("npx", ["drizzle-kit", "push"], {
      cwd: projectRoot,
      env: { TEST_DB_PATH: testDbPath },
    });

    serverProcess = spawnServerProcess({
      serverCommand: ["npx", "tsx", "src/index.ts"],
      port,
      testDbPath,
      projectRoot,
    });

    await waitForServer(baseUrl, 180); // 180 attempts * 200ms = 36 seconds

    const db = await import("./db.js");
    hotUpdater = db.hotUpdater;
  }, 120000);

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

  it("protects bundle management routes without hiding public update routes", async () => {
    const unauthorizedBundles = await fetch(
      `${baseUrl}/hot-updater/api/bundles`,
    );
    const authorizedBundles = await fetch(
      `${baseUrl}/hot-updater/api/bundles`,
      {
        headers: {
          Authorization: `Bearer ${TEST_MANAGEMENT_AUTH_TOKEN}`,
        },
      },
    );
    const version = await fetch(`${baseUrl}/hot-updater/version`);
    const updateCheck = await fetch(
      `${baseUrl}/hot-updater/app-version/ios/1.0.0/production/${NIL_UUID}/${NIL_UUID}`,
    );

    expect(unauthorizedBundles.status).toBe(401);
    expect(authorizedBundles.status).toBe(200);
    expect(version.status).toBe(200);
    expect(updateCheck.status).toBe(200);
  });
});
