import path from "path";
import { fileURLToPath } from "url";

import type { Bundle } from "@hot-updater/core";
import type { HotUpdaterAPI } from "@hot-updater/server";
import { prismaAdapter } from "@hot-updater/server/adapters/prisma";
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

  it("rejects exactly one concurrent opposing target clear", async () => {
    const database = prismaAdapter({ prisma, provider: "postgresql" });
    const id = "141ee03e-7599-4e29-a827-0c4732bc4f10";
    const createdChannel = await database.models.channels.insert({
      row: {
        id: "6ec76524-f26a-43e4-8c9a-f00c8c43ef70",
        name: "prisma-concurrency",
      },
      onConflict: "returnExisting",
    });
    expect(createdChannel.inserted).toBe(true);
    const channel = await database.models.channels.insert({
      row: {
        id: "f2f29e33-844e-40bf-bbf4-9ba10cfe67db",
        name: createdChannel.row.name,
      },
      onConflict: "returnExisting",
    });
    expect(channel).toEqual({ row: createdChannel.row, inserted: false });
    const row = {
      id,
      platform: "ios" as const,
      should_force_update: false,
      enabled: true,
      file_hash: "concurrent-target-hash",
      git_commit_hash: null,
      message: null,
      channel: channel.row.name,
      channel_id: channel.row.id,
      storage_uri: "storage://concurrent-target",
      target_app_version: "1.0.0",
      fingerprint_hash: "concurrent-fingerprint",
      metadata: {},
      rollout_cohort_count: 1000,
      target_cohorts: null,
      manifest_storage_uri: null,
      manifest_file_hash: null,
      asset_base_storage_uri: null,
    };
    await database.commit({
      changes: [
        {
          model: "bundles",
          operation: "insert",
          row,
        },
      ],
    });

    const results = await Promise.allSettled([
      database.commit({
        changes: [
          {
            model: "bundles",
            operation: "update",
            where: { id },
            update: { target_app_version: null },
          },
        ],
      }),
      database.commit({
        changes: [
          {
            model: "bundles",
            operation: "update",
            where: { id },
            update: { fingerprint_hash: null },
          },
        ],
      }),
    ]);

    expect(results.map(({ status }) => status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
    const stored = await database.models.bundles.findById(id);
    expect(
      [stored?.target_app_version, stored?.fingerprint_hash].filter(
        (target) => target !== null,
      ),
    ).toHaveLength(1);
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
    const channel = await database.models.channels.insert({
      row: {
        id: "c42763c0-29ec-4ff2-883a-dad3d1ee9b07",
        name: "prisma-rollback",
      },
      onConflict: "returnExisting",
    });
    const bundle = {
      platform: "ios" as const,
      should_force_update: false,
      enabled: true,
      file_hash: "rollback-hash",
      git_commit_hash: null,
      message: null,
      channel: channel.row.name,
      channel_id: channel.row.id,
      storage_uri: "storage://rollback",
      target_app_version: "1.0.0",
      fingerprint_hash: null,
      metadata: {},
      rollout_cohort_count: 1000,
      target_cohorts: null,
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
