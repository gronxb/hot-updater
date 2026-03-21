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
  const port = 13581;

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

    // Generate Prisma Client first from existing schema
    await execa("npx", ["prisma", "generate"], {
      cwd: projectRoot,
      env: { TEST_DB_PATH: testDbPath, DATABASE_URL: `file:${testDbPath}` },
    });

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

    // Apply schema to database using prisma db push
    await execa("npx", ["prisma", "db", "push", "--skip-generate"], {
      cwd: projectRoot,
      env: { TEST_DB_PATH: testDbPath, DATABASE_URL: `file:${testDbPath}` },
    });

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
