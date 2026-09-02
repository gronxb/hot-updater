import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

import type { Bundle } from "@hot-updater/core";
import type { HotUpdaterAPI } from "@hot-updater/server";
import { setupBundleMethodsTestSuite } from "@hot-updater/test-utils";
import {
  cleanupServer,
  createTestDbPath,
  killPort,
  spawnServerProcess,
  TEST_ADMIN_AUTH_TOKEN,
  waitForServer,
} from "@hot-updater/test-utils/node";
import { execa } from "execa";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Get the directory of this test file
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

describe("Hot Updater Handler Integration Tests (Express)", () => {
  let serverProcess: ReturnType<typeof execa> | null = null;
  let baseUrl: string;
  let testDbPath: string;
  let hotUpdater: HotUpdaterAPI;
  let provisioningEvidence: {
    readonly afterStatus: number;
    readonly beforeStatus: number;
    readonly coreReadBefore: boolean;
    readonly missingCoreExitCode: number | undefined;
    readonly missingCoreOutput: string;
    readonly mismatchExitCode: number | undefined;
    readonly mismatchOutput: string;
  };
  const port = 13581;

  beforeAll(async () => {
    // Kill any process using the port before starting
    await killPort(port);

    testDbPath = `${createTestDbPath(projectRoot)}.db`;
    await fs.mkdir(path.join(projectRoot, "data"), { recursive: true });
    await fs.writeFile(testDbPath, "", { flag: "a" });

    process.env.TEST_DB_PATH = testDbPath;

    baseUrl = `http://localhost:${port}`;

    // Run database migrations before starting server
    const hotUpdaterPkgPath = require.resolve("hot-updater/package.json");
    const hotUpdaterCli = path.join(
      path.dirname(hotUpdaterPkgPath),
      "dist/index.mjs",
    );

    // Generate Prisma schema from hotUpdater instance
    await execa(
      "node",
      [hotUpdaterCli, "db", "generate", "src/db.ts", "--yes"],
      {
        cwd: projectRoot,
        env: { TEST_DB_PATH: testDbPath },
      },
    );

    // Verify schema was correctly merged
    const schemaPath = path.join(projectRoot, "prisma", "schema.prisma");
    const schemaContent = await fs.readFile(schemaPath, "utf-8");

    // Should contain User model (existing model)
    if (!schemaContent.includes("model User")) {
      throw new Error("User model not found in schema after generate");
    }

    // Should contain hot-updater models
    if (!schemaContent.includes("model bundles")) {
      throw new Error("bundles model not found in schema after generate");
    }

    if (!schemaContent.includes("model private_hot_updater_settings")) {
      throw new Error(
        "private_hot_updater_settings model not found in schema after generate",
      );
    }

    // Should have hot-updater markers
    if (!schemaContent.includes("BEGIN HOT-UPDATER MODELS")) {
      throw new Error("HOT-UPDATER marker not found in schema after generate");
    }

    // Regenerate Prisma Client after hot-updater updates the Prisma schema.
    await execa("npx", ["prisma", "generate"], {
      cwd: projectRoot,
      env: { TEST_DB_PATH: testDbPath, DATABASE_URL: `file:${testDbPath}` },
    });

    const missingCore = await execa(
      "node",
      [hotUpdaterCli, "db", "migrate", "src/db.ts", "--yes"],
      {
        cwd: projectRoot,
        env: { TEST_DB_PATH: testDbPath, DATABASE_URL: `file:${testDbPath}` },
        reject: false,
      },
    );

    // Apply schema to database using prisma db push
    await execa("npx", ["prisma", "db", "push", "--skip-generate"], {
      cwd: projectRoot,
      env: { TEST_DB_PATH: testDbPath, DATABASE_URL: `file:${testDbPath}` },
    });

    const db = await import("./db.js");
    hotUpdater = db.hotUpdater;
    const readinessRequest = () =>
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
          installId: "prisma-readiness-retry",
          platform: "ios",
          sdkVersion: "2.0.0",
          toBundleId: "00000000-0000-7000-8000-000000000002",
          toReleaseId: null,
          type: "UNCHANGED",
          updateStrategy: null,
        }),
      });
    const beforeProvisioning =
      await hotUpdater.handlers.client(readinessRequest());
    const coreReadBefore = await hotUpdater.getBundles({ limit: 1 }).then(
      () => true,
      () => false,
    );

    await execa(
      "node",
      [hotUpdaterCli, "db", "migrate", "src/db.ts", "--yes"],
      {
        cwd: projectRoot,
        env: { TEST_DB_PATH: testDbPath, DATABASE_URL: `file:${testDbPath}` },
      },
    );
    const mismatch = await execa(
      "node",
      [hotUpdaterCli, "db", "migrate", "src/db.ts", "--yes"],
      {
        cwd: projectRoot,
        env: {
          DATABASE_URL: `file:${testDbPath}`,
          HOT_UPDATER_INSIGHTS_DATABASE_NAMESPACE:
            "00000000-0000-7000-8000-00000000e999",
          TEST_DB_PATH: testDbPath,
        },
        reject: false,
      },
    );
    await execa(
      "node",
      [hotUpdaterCli, "db", "migrate", "src/db.ts", "--yes"],
      {
        cwd: projectRoot,
        env: { TEST_DB_PATH: testDbPath, DATABASE_URL: `file:${testDbPath}` },
      },
    );
    const afterProvisioning =
      await hotUpdater.handlers.client(readinessRequest());
    provisioningEvidence = {
      afterStatus: afterProvisioning.status,
      beforeStatus: beforeProvisioning.status,
      coreReadBefore,
      missingCoreExitCode: missingCore.exitCode,
      missingCoreOutput: `${missingCore.stdout}\n${missingCore.stderr}`,
      mismatchExitCode: mismatch.exitCode,
      mismatchOutput: `${mismatch.stdout}\n${mismatch.stderr}`,
    };

    serverProcess = spawnServerProcess({
      serverCommand: ["npx", "tsx", "src/index.ts"],
      port,
      testDbPath,
      projectRoot,
    });

    await waitForServer(baseUrl, 180); // 180 attempts * 200ms = 36 seconds
  }, 60000);

  afterAll(async () => {
    await cleanupServer(baseUrl, serverProcess, testDbPath);
  }, 60000);

  setupBundleMethodsTestSuite({
    getBundleById: (id: string) => hotUpdater.getBundleById(id),
    insertBundle: (bundle: Bundle) => hotUpdater.insertBundle(bundle),
    getBundles: (options) => hotUpdater.getBundles(options),
    updateBundleById: (bundleId: string, newBundle: Partial<Bundle>) =>
      hotUpdater.updateBundleById(bundleId, newBundle),
    deleteBundleById: (bundleId: string) =>
      hotUpdater.deleteBundleById(bundleId),
  });

  it("keeps the client handler reachable without admin credentials", async () => {
    const response = await fetch(`${baseUrl}/hot-updater/version`);

    expect(response.status).toBe(200);
  });

  it("fails only Insights closed and rejects invalid provisioning plans before mutation", () => {
    expect(provisioningEvidence).toMatchObject({
      afterStatus: 204,
      beforeStatus: 503,
      coreReadBefore: true,
      missingCoreExitCode: 1,
      mismatchExitCode: 1,
    });
    expect(provisioningEvidence.missingCoreOutput).toContain(
      "Prisma core schema is not ready",
    );
    expect(provisioningEvidence.mismatchOutput).toContain(
      "Prisma Insights database namespace mismatch",
    );
  });

  it.each([
    ["missing", undefined],
    ["incorrect", "Bearer incorrect-token"],
  ])("rejects %s admin credentials", async (_label, authorization) => {
    const response = await fetch(`${baseUrl}/hot-updater/admin/channels`, {
      headers: authorization ? { Authorization: authorization } : undefined,
    });

    expect(response.status).toBe(401);
  });

  it("allows authenticated admin requests without caching", async () => {
    const response = await fetch(`${baseUrl}/hot-updater/admin/channels`, {
      headers: {
        Authorization: `Bearer ${TEST_ADMIN_AUTH_TOKEN}`,
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("records the first Insights event after the supported database setup", async () => {
    const installId = "fresh-prisma-installation";
    const ingestion = await fetch(`${baseUrl}/hot-updater/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        appVersion: "1.0.0",
        channel: "production",
        cohort: "default",
        fingerprintHash: null,
        fromBundleId: null,
        fromReleaseId: null,
        installId,
        platform: "ios",
        sdkVersion: "2.0.0",
        toBundleId: "00000000-0000-7000-8000-000000000001",
        toReleaseId: null,
        type: "UNCHANGED",
        updateStrategy: null,
      }),
    });

    expect(ingestion.status).toBe(204);

    const history = await fetch(
      `${baseUrl}/hot-updater/admin/events?limit=10`,
      {
        headers: {
          Authorization: `Bearer ${TEST_ADMIN_AUTH_TOKEN}`,
        },
      },
    );

    expect(history.status).toBe(200);
    const body = await history.json();
    expect(body).toMatchObject({ state: "ready" });
    const events = (body as { data: { data: readonly unknown[] } }).data.data;
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          install_id: installId,
          type: "UNCHANGED",
        }),
      ]),
    );
  });

  it("serves concurrent Console Insights reads on SQLite", async () => {
    const authorization = `Bearer ${TEST_ADMIN_AUTH_TOKEN}`;
    const paths = [
      "/events?limit=10",
      "/installations/overview",
      "/installations/active?window=24h",
      "/installations?kind=installationId&installId=prisma-readiness-retry&limit=1",
      "/installations?kind=contains&query=prisma-readiness&limit=10",
    ];
    const responses = await Promise.all(
      paths.map((path) =>
        fetch(`${baseUrl}/hot-updater/admin${path}`, {
          headers: { Authorization: authorization },
        }),
      ),
    );

    expect(responses.map((response) => response.status)).toEqual(
      Array(paths.length).fill(200),
    );
  });

  it("should preserve User model and add hot-updater models in schema.prisma", async () => {
    const schemaPath = path.join(projectRoot, "prisma", "schema.prisma");
    const schemaContent = await fs.readFile(schemaPath, "utf-8");

    // Verify User model exists (user's custom model)
    expect(schemaContent).toContain("model User");
    expect(schemaContent).toContain("email     String   @unique");

    // Verify hot-updater models exist
    expect(schemaContent).toContain("model bundles");
    expect(schemaContent).toContain("model private_hot_updater_settings");

    // Verify hot-updater markers
    expect(schemaContent).toContain("BEGIN HOT-UPDATER MODELS");
    expect(schemaContent).toContain("END HOT-UPDATER MODELS");

    // Verify only one set of markers exists
    const beginMatches = schemaContent.match(/BEGIN HOT-UPDATER MODELS/g);
    const endMatches = schemaContent.match(/END HOT-UPDATER MODELS/g);
    expect(beginMatches).toHaveLength(1);
    expect(endMatches).toHaveLength(1);
  });
});
