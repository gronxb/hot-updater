import path from "path";
import { fileURLToPath } from "url";

import type { Bundle } from "@hot-updater/core";
import {
  ReleaseManagementError,
  type BundleEventRow,
} from "@hot-updater/plugin-core";
import { prismaAdapter } from "@hot-updater/server/adapters/prisma";
import {
  createDatabaseCoreApi,
  createDatabasePluginApis,
} from "@hot-updater/server/db";
import {
  createInsightsModel,
  insights as insightsPlugin,
} from "@hot-updater/server/plugins/insights";
import {
  createHttpTestClient,
  setupReleaseCatalogTestSuite,
} from "@hot-updater/test-utils";
import { setupBundleMethodsTestSuite } from "@hot-updater/test-utils";
import {
  assertDockerComposeAvailable,
  cleanupServer,
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

    // Set the collations Prisma cannot declare, then write the settings rows
    await execa(
      "node",
      [hotUpdaterCli, "db", "migrate", "src/db.ts", "--yes"],
      {
        cwd: projectRoot,
        env: {
          DATABASE_URL: testDatabaseUrl,
          TEST_DATABASE_URL: testDatabaseUrl,
        },
      },
    );

    serverProcess = spawnServerProcess({
      serverCommand: ["npx", "tsx", "src/index.ts"],
      port,
      testDbPath: "",
      projectRoot,
      env: { TEST_DATABASE_URL: testDatabaseUrl },
    });

    await waitForServer(baseUrl, 180); // 180 attempts * 200ms = 36 seconds

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

  const getClient = () =>
    createHttpTestClient({
      clientBaseUrl: `${baseUrl}/hot-updater`,
      adminBaseUrl: `${baseUrl}/hot-updater/admin`,
      adminHeaders: { Authorization: `Bearer ${TEST_ADMIN_AUTH_TOKEN}` },
    });

  setupBundleMethodsTestSuite({ getClient });

  setupReleaseCatalogTestSuite({ getClient });

  it("keeps every concurrent Insights event and the newest installation head", async () => {
    const insights = createInsightsModel(
      createDatabasePluginApis(prismaAdapter({ prisma, provider: "postgresql" }), [
        insightsPlugin(),
      ]).insights,
    );
    const installId = "prisma-concurrent-insights";
    const now = Date.now();
    const events: BundleEventRow[] = Array.from({ length: 16 }, (_, index) => ({
      id: `0198a5b1-0000-7000-8000-${String(index + 1).padStart(12, "0")}`,
      type: "UPDATE_APPLIED",
      install_id: installId,
      user_id: index === 15 ? null : "previous-user",
      metadata: {
        username: null,
        cohort: "0",
        update_strategy: "appVersion",
        fingerprint_hash: null,
        sdk_version: null,
      },
      from_bundle_id: "0198a5b1-0000-7000-8001-000000000001",
      from_release_id: null,
      to_bundle_id: `0198a5b1-0000-7000-8002-${String(index + 1).padStart(12, "0")}`,
      to_release_id: null,
      platform: "ios",
      app_version: "1.0.0",
      channel: "production",
      received_at_ms: now + index,
    }));
    await Promise.all(events.map((event) => insights.recordEvent({ event })));
    expect(
      await prisma.bundle_events.count({ where: { install_id: installId } }),
    ).toBe(16);
    await expect(insights.findLatestEvents({ installId })).resolves.toEqual([
      events[15],
    ]);
    await expect(
      insights.findLatestEvents({ userId: "previous-user", limit: 101 }),
    ).resolves.toEqual([]);
  });

  it("lets exactly one of two concurrent policy changes at one revision win", async () => {
    const core = createDatabaseCoreApi(
      prismaAdapter({ prisma, provider: "postgresql" }),
    );
    const [deployed] = await core.deploy([
      {
        bundle: bundleOf("0198a5b0-0000-7000-8000-000000000001"),
        release: policyOf("prisma-concurrency"),
      },
    ]);
    const release = deployed!.release!;
    const change = (message: string) =>
      core.updateReleasePolicy({
        releaseId: release.id,
        expectedRevision: release.revision,
        patch: { message },
      });

    const results = await Promise.allSettled([
      change("writer-a"),
      change("writer-b"),
    ]);

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(
      1,
    );
    const refused = results.find(({ status }) => status === "rejected");
    expect((refused as PromiseRejectedResult).reason).toBeInstanceOf(
      ReleaseManagementError,
    );
    const updated = await core.getRelease(release.id);
    expect(updated).toMatchObject({ revision: release.revision + 1 });
    const disabled = await core.updateReleasePolicy({
      expectedRevision: updated!.revision,
      patch: { enabled: false },
      releaseId: updated!.id,
    });
    await core.deleteRelease({
      expectedRevision: disabled.release!.revision,
      releaseId: disabled.release!.id,
    });
  });

  it("rolls back patch cleanup when bundle deletion fails", async () => {
    const core = createDatabaseCoreApi(
      prismaAdapter({ prisma, provider: "postgresql" }),
    );
    const baseId = "5d8b5ebf-8008-4ab8-9fb5-79af0ec766c3";
    const targetId = "5e08db65-e31d-4de3-a795-8492327c30d8";
    // Both bundles stored with no release, the target with its patch.
    for (const bundle of [
      bundleOf(baseId),
      {
        ...bundleOf(targetId),
        patches: [
          {
            baseBundleId: baseId,
            baseFileHash: "rollback-base-hash",
            patchFileHash: "rollback-patch-hash",
            patchStorageUri: "storage://rollback-patch",
            byteSize: 3_000_000_002,
          },
        ],
      },
    ]) {
      const [deployed] = await core.deploy([
        { bundle, release: policyOf("prisma-rollback", false) },
      ]);
      await core.deleteRelease({ releaseId: deployed!.release!.id });
    }

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
      await expect(core.deleteBundles([targetId])).rejects.toMatchObject({
        // The engine reports a failed write as ambiguous, with the database's error as its cause.
        cause: {
          message: expect.stringContaining(
            "injected Prisma bundle delete failure",
          ),
        },
      });

      await expect(core.getBundle(targetId)).resolves.toMatchObject({
        bundle: { id: targetId },
        patches: [expect.objectContaining({ base_bundle_id: baseId })],
      });
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

const bundleOf = (id: string): Bundle => ({
  assetBaseStorageUri: "storage://assets",
  id,
  platform: "ios",
  gitCommitHash: null,
  manifestFileHash: `${id}-manifest-hash`,
  manifestStorageUri: `storage://${id}/manifest.json`,
});

const policyOf = (channel: string, enabled = true) => ({
  channel,
  enabled,
  fingerprintHash: null,
  message: null,
  shouldForceUpdate: false,
  targetAppVersion: "1.0.0",
});
