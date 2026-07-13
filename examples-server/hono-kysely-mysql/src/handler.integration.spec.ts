import path from "path";
import { fileURLToPath } from "url";

import type { Bundle } from "@hot-updater/core";
import { createHotUpdater, type HotUpdaterAPI } from "@hot-updater/server";
import { kyselyAdapter } from "@hot-updater/server/adapters/kysely";
import { createMigrator } from "@hot-updater/server/db";
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
import { Kysely, MysqlDialect, sql } from "kysely";
import { createPool, type RowDataPacket } from "mysql2";
import type { Pool as PromisePool } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Get the directory of this test file
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
assertDockerComposeAvailable(
  "Hono + MySQL integration tests require Docker Compose and a running Docker daemon.",
);

describe("Hot Updater Handler Integration Tests (Hono + MySQL)", () => {
  let serverProcess: ReturnType<typeof execa> | null = null;
  let baseUrl: string;
  let hotUpdater: HotUpdaterAPI;
  let closeDatabase: (() => Promise<void>) | null = null;
  const port = 13579;

  beforeAll(async () => {
    // Kill any process using the port before starting
    await killPort(port);

    baseUrl = `http://localhost:${port}`;

    // Ensure Docker MySQL is running
    console.log("Starting MySQL Docker container...");
    await execa("docker", ["compose", "up", "-d", "--wait"], {
      cwd: projectRoot,
    });

    // Wait for MySQL to be healthy
    console.log("Waiting for MySQL to be ready...");
    await waitForMySQLReady(projectRoot, 30);

    // Additional delay to ensure MySQL is fully stabilized
    console.log("Waiting for MySQL to stabilize...");
    await new Promise((resolve) => setTimeout(resolve, 3000));

    const db = await import("./db.js");
    const { createMigrator } = await import("@hot-updater/server/db");
    const migrator = createMigrator(db.hotUpdater);
    const result = await migrator.migrateToLatest({
      mode: "from-schema",
      updateSettings: true,
    });
    await result.execute();

    hotUpdater = db.hotUpdater;
    closeDatabase = db.closeDatabase;

    serverProcess = spawnServerProcess({
      serverCommand: ["npx", "tsx", "src/index.ts"],
      port,
      testDbPath: "", // Not needed for MySQL
      projectRoot,
    });

    await waitForServer(baseUrl, 180); // 180 attempts * 200ms = 36 seconds
  }, 120000);

  afterAll(async () => {
    await cleanupServer(baseUrl, serverProcess, "");
    await closeDatabase?.();

    // Clean up database after tests
    console.log("Cleaning up test database...");
    await cleanupMySQLDatabase(projectRoot);
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

  it("resumes a partially applied MySQL channel migration", async () => {
    const database = `hot_updater_retry_${process.pid}`;
    const admin = createPool({
      host: process.env.MYSQL_HOST || "localhost",
      port: Number(process.env.MYSQL_PORT) || 3307,
      user: "root",
      password: process.env.MYSQL_ROOT_PASSWORD || "hot_updater_root",
    }).promise();
    await admin.query(`drop database if exists \`${database}\``);
    await admin.query(`create database \`${database}\``);
    await admin.query(
      `grant all privileges on \`${database}\`.* to 'hot_updater'@'%'`,
    );

    const pool = createPool({
      host: process.env.MYSQL_HOST || "localhost",
      port: Number(process.env.MYSQL_PORT) || 3307,
      user: process.env.MYSQL_USER || "hot_updater",
      password: process.env.MYSQL_PASSWORD || "hot_updater_dev",
      database,
    });
    const dialectPool = pool as unknown as ConstructorParameters<
      typeof MysqlDialect
    >[0]["pool"];
    const db = new Kysely<SettingsDatabase>({
      dialect: new MysqlDialect({ pool: dialectPool }),
    });

    try {
      await sql
        .raw(`
        create table bundles (
          id varchar(255) primary key,
          channel varchar(255) not null
        )
      `)
        .execute(db);
      await sql
        .raw(`
        create table channels (
          id varchar(255) primary key,
          name varchar(255) not null
        )
      `)
        .execute(db);
      await sql
        .raw(`
        create table private_hot_updater_settings (
          \`key\` varchar(255) primary key,
          value varchar(255) not null
        )
      `)
        .execute(db);
      await sql
        .raw(
          "insert into bundles (id, channel) values ('bundle-1', 'production')",
        )
        .execute(db);
      await sql
        .raw("insert into channels (id, name) values ('production', 'renamed')")
        .execute(db);
      await sql
        .raw(
          "insert into private_hot_updater_settings (`key`, value) values ('version', '0.31.0')",
        )
        .execute(db);

      const migrationHotUpdater = createHotUpdater({
        database: kyselyAdapter({ db, provider: "mysql" }),
      });
      const migrator = createMigrator(migrationHotUpdater);
      const interrupted = await migrator.migrateToLatest({
        mode: "from-schema",
        updateSettings: true,
      });
      await expect(interrupted.execute()).rejects.toThrow();

      const partialColumns = await sql<{ readonly name: string }>`
        select column_name as name
        from information_schema.columns
        where table_schema = ${database} and table_name = 'bundles'
      `.execute(db);
      expect(partialColumns.rows.map(({ name }) => name)).toEqual(
        expect.arrayContaining(["channel", "channel_id"]),
      );
      expect(await migrator.getVersion()).toBe("0.31.0");

      await sql`delete from channels where id = ${"production"}`.execute(db);
      const retry = await migrator.migrateToLatest({
        mode: "from-schema",
        updateSettings: true,
      });
      await retry.execute();

      expect(await migrator.getVersion()).toBe("0.36.0");
      const migrated = await sql<{
        readonly channel: string;
        readonly channel_id: string;
      }>`
        select channel, channel_id from bundles
      `.execute(db);
      expect(migrated.rows).toEqual([
        { channel: "production", channel_id: "production" },
      ]);
      const finalColumns = await sql<{ readonly name: string }>`
        select column_name as name
        from information_schema.columns
        where table_schema = ${database} and table_name = 'bundles'
      `.execute(db);
      expect(finalColumns.rows.map(({ name }) => name)).toEqual(
        expect.arrayContaining(["channel", "channel_id"]),
      );
    } finally {
      await db.destroy();
      await admin.query(`drop database if exists \`${database}\``);
      await admin.end();
    }
  });

  it("serializes fumadb patch creation with bundle deletion", async () => {
    const database = `hot_updater_fumadb_${process.pid}`;
    const gate = `hot_updater_patch_gate_${process.pid}`;
    const admin = createPool({
      host: process.env.MYSQL_HOST || "localhost",
      port: Number(process.env.MYSQL_PORT) || 3307,
      user: "root",
      password: process.env.MYSQL_ROOT_PASSWORD || "hot_updater_root",
    }).promise();
    await admin.query(`drop database if exists \`${database}\``);
    await admin.query(`create database \`${database}\``);
    await admin.query(
      `grant all privileges on \`${database}\`.* to 'hot_updater'@'%'`,
    );

    const createDatabase = () => {
      const pool = createPool({
        host: process.env.MYSQL_HOST || "localhost",
        port: Number(process.env.MYSQL_PORT) || 3307,
        user: process.env.MYSQL_USER || "hot_updater",
        password: process.env.MYSQL_PASSWORD || "hot_updater_dev",
        database,
        connectionLimit: 1,
      });
      const dialectPool = pool as unknown as ConstructorParameters<
        typeof MysqlDialect
      >[0]["pool"];
      return new Kysely<object>({
        dialect: new MysqlDialect({ pool: dialectPool }),
      });
    };
    const writer = createDatabase();
    const remover = createDatabase();
    const control = createDatabase();

    try {
      const adapter = kyselyAdapter({
        db: writer,
        provider: "mysql",
        relationMode: "fumadb",
      });
      const migrator = createMigrator(createHotUpdater({ database: adapter }));
      const migration = await migrator.migrateToLatest({
        mode: "from-schema",
        updateSettings: true,
      });
      await migration.execute();

      const ownerId = "fumadb-owner";
      const baseId = "fumadb-base";
      await adapter.create({
        model: "channels",
        data: { id: "channel-production", name: "production" },
      });
      for (const id of [baseId, ownerId]) {
        await adapter.create({
          model: "bundles",
          data: createAdapterBundleRow(id),
        });
      }
      await sql`select get_lock(${gate}, 5)`.execute(control);
      await admin.query(
        `create trigger \`${database}\`.pause_fumadb_patch before insert on \`${database}\`.bundle_patches for each row set @hot_updater_patch_gate = get_lock('${gate}', 10)`,
      );

      const patchCreate = adapter.create({
        model: "bundle_patches",
        data: {
          id: "fumadb-patch",
          bundle_id: ownerId,
          base_bundle_id: baseId,
          base_file_hash: "base-hash",
          patch_file_hash: "patch-hash",
          patch_storage_uri: "storage://fumadb-patch",
          order_index: 0,
        },
      });
      await waitForMySQLUserLock(admin, database);

      const deleteAdapter = kyselyAdapter({
        db: remover,
        provider: "mysql",
        relationMode: "fumadb",
      });
      let deleteSettled = false;
      const bundleDelete = deleteAdapter
        .delete({
          model: "bundles",
          where: [{ field: "id", value: ownerId }],
        })
        .finally(() => {
          deleteSettled = true;
        });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(deleteSettled).toBe(false);

      await sql`select release_lock(${gate})`.execute(control);
      await Promise.all([patchCreate, bundleDelete]);

      await expect(
        deleteAdapter.findOne({
          model: "bundles",
          where: [{ field: "id", value: ownerId }],
        }),
      ).resolves.toBeNull();
      await expect(
        deleteAdapter.findMany({ model: "bundle_patches" }),
      ).resolves.toEqual([]);
    } finally {
      await Promise.all([
        writer.destroy(),
        remover.destroy(),
        control.destroy(),
      ]);
      await admin.query(`drop database if exists \`${database}\``);
      await admin.end();
    }
  }, 30000);
});

interface SettingsDatabase {
  readonly private_hot_updater_settings: {
    readonly key: string;
    readonly value: string;
  };
}

const createAdapterBundleRow = (id: string) => ({
  id,
  platform: "ios" as const,
  should_force_update: false,
  enabled: true,
  file_hash: `${id}-hash`,
  git_commit_hash: null,
  message: null,
  channel: "production",
  channel_id: "channel-production",
  storage_uri: `storage://${id}`,
  target_app_version: "1.0.0",
  fingerprint_hash: null,
  metadata: {},
  rollout_cohort_count: 1000,
  target_cohorts: null,
  manifest_storage_uri: null,
  manifest_file_hash: null,
  asset_base_storage_uri: null,
});

const waitForMySQLUserLock = async (
  admin: PromisePool,
  database: string,
): Promise<void> => {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const [rows] = await admin.query<
      (RowDataPacket & { readonly waiting: number })[]
    >(
      "select count(*) as waiting from information_schema.processlist where db = ? and state = 'User lock'",
      [database],
    );
    if ((rows[0]?.waiting ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for the MySQL patch insertion barrier.");
};

// Helper function to wait for MySQL to be ready
async function waitForMySQLReady(
  projectRoot: string,
  maxAttempts: number,
): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      // Check Docker container health status
      const healthResult = await execa(
        "docker",
        ["inspect", "--format={{.State.Health.Status}}", "hono-kysely-mysql"],
        { cwd: projectRoot },
      );
      if (healthResult.stdout.trim() === "healthy") {
        console.log("MySQL is ready!");
        return;
      }
    } catch {
      // Container not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("MySQL failed to become ready");
}

// Helper function to clean up test database
async function cleanupMySQLDatabase(projectRoot: string): Promise<void> {
  try {
    // Drop and recreate database for clean state
    await execa(
      "docker",
      [
        "compose",
        "exec",
        "-T",
        "mysql",
        "mysql",
        "-uhot_updater",
        "-phot_updater_dev",
        "-e",
        "DROP DATABASE IF EXISTS hot_updater; CREATE DATABASE hot_updater;",
      ],
      { cwd: projectRoot },
    );
  } catch (error) {
    console.error("Error cleaning up database:", error);
  }
}
