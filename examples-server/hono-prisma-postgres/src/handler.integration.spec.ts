import path from "path";
import { fileURLToPath } from "url";

import type { Bundle, LegacyBundle } from "@hot-updater/core";
import type { HotUpdaterAPI } from "@hot-updater/server";
import { prismaAdapter } from "@hot-updater/server/adapters/prisma";
import {
  deleteLegacyBundle,
  setupBundleMethodsTestSuite,
} from "@hot-updater/test-utils";
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

describe("Hot Updater Handler Integration Tests (Hono + Prisma + PostgreSQL)", () => {
  let serverProcess: ReturnType<typeof execa> | null = null;
  let baseUrl: string;
  let testDbName: string;
  const port = 13583;
  let hotUpdater: HotUpdaterAPI;
  let prisma: typeof import("./prisma.js").prisma;

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
      "dist/index.mjs",
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
    prisma = (await import("./prisma.js")).prisma;
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

  setupBundleMethodsTestSuite({
    getBundleById: (id: string) => hotUpdater.getBundleById(id),
    getChannels: () => hotUpdater.getChannels(),
    insertBundle: (bundle: LegacyBundle) => hotUpdater.insertBundle(bundle),
    getBundles: (options) => hotUpdater.getBundles(options),
    updateBundleById: (bundleId: string, newBundle: Partial<Bundle>) =>
      hotUpdater.updateBundleById(bundleId, newBundle),
    deleteBundleById: (bundleId: string) =>
      deleteLegacyBundle(hotUpdater, bundleId),
  });

  it("allows exactly one concurrent Release/catalog CAS writer", async () => {
    const database = prismaAdapter({ prisma, provider: "postgresql" });
    const id = "0198a5b0-0000-7000-8000-000000000001";
    await hotUpdater.insertBundle({
      id,
      platform: "ios",
      shouldForceUpdate: false,
      enabled: true,
      fileHash: "concurrent-target-hash",
      gitCommitHash: null,
      message: null,
      channel: "prisma-concurrency",
      storageUri: "storage://concurrent-target",
      targetAppVersion: "1.0.0",
      fingerprintHash: null,
    });
    const release = await database.models.releases.findById(id);
    if (release === null) throw new Error("Expected the legacy Release");
    const catalog = await database.models.releaseCatalogs.findByScopeKey(
      release.scope_key,
    );
    if (catalog === null) throw new Error("Expected the Release catalog");
    const commit = (message: string) =>
      database.commit({
        expectations: [
          { model: "releases", id, revision: release.revision },
          {
            model: "releaseCatalogs",
            scopeKey: catalog.scope_key,
            generation: catalog.generation,
          },
        ],
        changes: [
          {
            model: "releases",
            operation: "update",
            where: { id },
            update: { message, revision: release.revision + 1 },
          },
          {
            model: "releaseCatalogs",
            operation: "put",
            row: { ...catalog, generation: catalog.generation + 1 },
          },
        ],
      });

    const results = await Promise.all([commit("writer-a"), commit("writer-b")]);

    expect(results.filter(({ committed }) => committed)).toHaveLength(1);
    expect(results.filter(({ committed }) => !committed)).toHaveLength(1);
    expect(await database.models.releases.findById(id)).toMatchObject({
      revision: release.revision + 1,
    });
  });

  it("rolls back emulated patch cleanup when bundle deletion fails", async () => {
    const database = prismaAdapter({
      prisma,
      provider: "postgresql",
      relationMode: "prisma",
    });
    const baseId = "5d8b5ebf-8008-4ab8-9fb5-79af0ec766c3";
    const targetId = "5e08db65-e31d-4de3-a795-8492327c30d8";
    const patchId = "prisma-rollback-patch";
    const bundle = {
      platform: "ios" as const,
      file_hash: "rollback-hash",
      git_commit_hash: null,
      storage_uri: "storage://rollback",
      metadata: {},
      manifest_storage_uri: null,
      manifest_file_hash: null,
      asset_base_storage_uri: null,
    };
    for (const id of [baseId, targetId]) {
      const row = { ...bundle, id };
      await database.commit({
        changes: [
          {
            model: "bundles",
            operation: "insert",
            row,
          },
        ],
      });
    }
    const patch = {
      id: patchId,
      bundle_id: targetId,
      base_bundle_id: baseId,
      base_file_hash: "rollback-base-hash",
      patch_file_hash: "rollback-patch-hash",
      patch_storage_uri: "storage://rollback-patch",
      order_index: 0,
    };
    await database.commit({
      changes: [
        {
          model: "bundlePatches",
          operation: "insert",
          row: patch,
        },
      ],
    });

    await prisma.$executeRawUnsafe(`
            CREATE FUNCTION fail_prisma_bundle_delete() RETURNS trigger AS $$
            BEGIN
              RAISE EXCEPTION 'injected Prisma bundle delete failure';
            END;
            $$ LANGUAGE plpgsql;
          `);
    await prisma.$executeRawUnsafe(`
            CREATE TRIGGER fail_prisma_bundle_delete
            BEFORE DELETE ON bundles
            FOR EACH ROW EXECUTE FUNCTION fail_prisma_bundle_delete();
          `);

    try {
      await expect(
        database.commit({
          changes: [
            {
              model: "bundles",
              operation: "delete",
              where: { id: targetId },
            },
          ],
        }),
      ).rejects.toThrow("injected Prisma bundle delete failure");

      await expect(
        database.models.bundles.findById(targetId),
      ).resolves.toMatchObject({ id: targetId });
      await expect(
        database.models.bundlePatches.findByBundleIds([targetId]),
      ).resolves.toContainEqual(expect.objectContaining({ id: patchId }));
    } finally {
      await prisma.$executeRawUnsafe(
        "DROP TRIGGER IF EXISTS fail_prisma_bundle_delete ON bundles;",
      );
      await prisma.$executeRawUnsafe(
        "DROP FUNCTION IF EXISTS fail_prisma_bundle_delete();",
      );
    }
  });
});
