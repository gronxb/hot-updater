import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

import { setupBundleMethodsTestSuite } from "@hot-updater/test-utils";
import {
  cleanupServer,
  createBundleMethodsFromServer,
  createTestDbPath,
  killPort,
  spawnServerProcess,
  TEST_MANAGEMENT_AUTH_TOKEN,
  waitForServer,
} from "@hot-updater/test-utils/node";
import { execa } from "execa";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Get the directory of this test file
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

describe("Hot Updater Handler Integration Tests (Hono + Drizzle + PGlite)", () => {
  let serverProcess: ReturnType<typeof execa> | null = null;
  let baseUrl: string;
  let testDbPath: string;
  let bundleMethods: ReturnType<typeof createBundleMethodsFromServer>;
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

    bundleMethods = createBundleMethodsFromServer({
      baseUrl: `${baseUrl}/hot-updater`,
    });
  }, 120000);

  afterAll(async () => {
    await cleanupServer(baseUrl, serverProcess, testDbPath);
  }, 60000);

  setupBundleMethodsTestSuite({
    getBundleById: (id) => bundleMethods.getBundleById(id),
    getChannels: () => bundleMethods.getChannels(),
    insertBundle: (bundle) => bundleMethods.insertBundle(bundle),
    getBundles: (options) => bundleMethods.getBundles(options),
    updateBundleById: (bundleId, newBundle) =>
      bundleMethods.updateBundleById(bundleId, newBundle),
    deleteBundleById: (bundleId) => bundleMethods.deleteBundleById(bundleId),
  });

  it("protects bundle management routes without hiding public catalog routes", async () => {
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
      `${baseUrl}/hot-updater/v2/release-catalogs/app-version/default/ios/cHJvZHVjdGlvbg/1.0.0`,
    );

    expect(unauthorizedBundles.status).toBe(401);
    expect(authorizedBundles.status).toBe(200);
    expect(version.status).toBe(200);
    expect(updateCheck.status).toBe(200);
    expect(updateCheck.headers.get("content-type")).toContain(
      "application/vnd.hot-updater.release-catalog+json",
    );
  });
});
