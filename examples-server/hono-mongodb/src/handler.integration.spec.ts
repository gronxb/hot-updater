import path from "path";
import { fileURLToPath } from "url";

import type { Bundle } from "@hot-updater/core";
import type { HotUpdaterAPI } from "@hot-updater/server";
import { setupBundleMethodsTestSuite } from "@hot-updater/test-utils";
import {
  assertDockerComposeAvailable,
  cleanupServer,
  killPort,
  spawnServerProcess,
  waitForServer,
} from "@hot-updater/test-utils/node";
import { execa } from "execa";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Get the directory of this test file
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
assertDockerComposeAvailable(
  "Hono + MongoDB integration tests require Docker Compose and a running Docker daemon.",
);

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
    const testMongoUrl = `mongodb://localhost:27018/${testDbName}?replicaSet=rs0&directConnection=true`;

    process.env.TEST_MONGODB_URL = testMongoUrl;

    baseUrl = `http://localhost:${port}`;

    // Ensure Docker Compose is healthy before migration.
    await execa("docker", ["compose", "up", "-d", "--wait"], {
      cwd: projectRoot,
    });

    // Run database migrations
    const hotUpdaterPkgPath = require.resolve("hot-updater/package.json");
    const hotUpdaterCli = path.join(
      path.dirname(hotUpdaterPkgPath),
      "dist/index.mjs",
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

    await waitForServer(baseUrl, 180); // 180 attempts * 200ms = 36 seconds

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

  it("serves Insights immediately after the CLI migration", async () => {
    const ingestion = await hotUpdater.handlers.client(
      new Request("http://localhost/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          appVersion: "1.0.0",
          channel: "production",
          cohort: "default",
          fingerprintHash: null,
          fromBundleId: null,
          fromReleaseId: null,
          installId: "cli-provisioned-mongodb-install",
          platform: "ios",
          sdkVersion: "2.0.0",
          toBundleId: "00000000-0000-7000-8000-000000000001",
          toReleaseId: null,
          type: "UNCHANGED",
          updateStrategy: null,
        }),
      }),
    );
    expect(ingestion.status).toBe(204);

    let overview: unknown;
    for (let attempt = 0; attempt < 32; attempt++) {
      const response = await hotUpdater.handlers.admin(
        new Request("http://localhost/installations/overview"),
      );
      expect(response.status).toBe(200);
      overview = await response.json();
      if (Reflect.get(overview as object, "state") !== "preparing") break;
    }
    expect(overview).toMatchObject({
      state: "ready",
      data: { summary: { trackedInstallations: 1 } },
    });
  });

  setupBundleMethodsTestSuite({
    getBundleById: (id: string) => hotUpdater.getBundleById(id),
    insertBundle: (bundle: Bundle) => hotUpdater.insertBundle(bundle),
    getBundles: (options) => hotUpdater.getBundles(options),
    updateBundleById: (bundleId: string, newBundle: Partial<Bundle>) =>
      hotUpdater.updateBundleById(bundleId, newBundle),
    deleteBundleById: (bundleId: string) =>
      hotUpdater.deleteBundleById(bundleId),
  });
});
