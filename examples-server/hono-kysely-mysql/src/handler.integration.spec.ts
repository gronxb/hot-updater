import path from "path";
import { fileURLToPath } from "url";

import type { Bundle } from "@hot-updater/core";
import { createHotUpdater, type HotUpdaterAPI } from "@hot-updater/server";
import { kyselyAdapter } from "@hot-updater/server/adapters/kysely";
import { createMigrator } from "@hot-updater/server/db";
import { setupBundleMethodsTestSuite } from "@hot-updater/test-utils";
import {
  assertDockerComposeAvailable,
  cleanupServer,
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
    await migrateCurrentSchema(db.hotUpdater, projectRoot);

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

  setupBundleMethodsTestSuite({
    getBundleById: (id: string) => hotUpdater.getBundleById(id),
    insertBundle: (bundle: Bundle) => hotUpdater.insertBundle(bundle),
    getBundles: (options) => hotUpdater.getBundles(options),
    updateBundleById: (bundleId: string, newBundle: Partial<Bundle>) =>
      hotUpdater.updateBundleById(bundleId, newBundle),
    deleteBundleById: (bundleId: string) =>
      hotUpdater.deleteBundleById(bundleId),
  });

  it("keeps the canonical latest event through concurrent writes and altered retries", async () => {
    const { kysely } = await import("./db.js");
    const insights = kyselyAdapter({ db: kysely, provider: "mysql" }).models
      .insights;
    const previous = {
      ...createBundleEventRowFixture("9805", 100),
      user_id: "mysql-previous-user",
    };
    const newer = {
      ...createBundleEventRowFixture("9801", 200),
      install_id: previous.install_id,
      user_id: "mysql-current-user",
    };
    await insights.recordEvent({ event: previous });
    await insights.recordEvent({ event: newer });
    await expect(
      insights.findLatestEvents({ installId: previous.install_id }),
    ).resolves.toEqual([newer]);
    const tied = {
      ...newer,
      id: createBundleEventRowFixture("9802", 300).id,
      received_at_ms: 300,
    };
    const newest = {
      ...tied,
      id: createBundleEventRowFixture("9803", 300).id,
      channel: "preview",
      metadata: { ...tied.metadata, device: { locale: "ko-KR" } },
    };
    await Promise.all([
      insights.recordEvent({ event: tied }),
      insights.recordEvent({ event: newest }),
      insights.recordEvent({ event: previous }),
      insights.recordEvent({
        event: {
          ...previous,
          install_id: "mysql-altered-retry",
          user_id: "mysql-altered-user",
          received_at_ms: 400,
        },
      }),
    ]);

    await expect(
      insights.findLatestEvents({ installId: previous.install_id }),
    ).resolves.toEqual([newest]);
    await expect(
      insights.findLatestEvents({ userId: "mysql-previous-user", limit: 10 }),
    ).resolves.toEqual([]);
    await expect(
      insights.findLatestEvents({ userId: "mysql-current-user", limit: 10 }),
    ).resolves.toEqual([newest]);
    await expect(
      insights.findLatestEvents({ installId: "mysql-altered-retry" }),
    ).resolves.toEqual([]);
    expect(
      (
        await sql`select id from bundle_events where id = ${previous.id}`.execute(
          kysely,
        )
      ).rows,
    ).toEqual([{ id: previous.id }]);
  });

  it("rolls back the MySQL event if its head fails, then records the retry", async () => {
    const { kysely } = await import("./db.js");
    const insights = kyselyAdapter({ db: kysely, provider: "mysql" }).models
      .insights;
    const event = createBundleEventRowFixture("9810", 100);
    await sql`alter table bundle_event_heads add constraint reject_test_head check (install_id <> 'install-9810')`.execute(
      kysely,
    );
    try {
      await expect(insights.recordEvent({ event })).rejects.toThrow();
      expect(
        (
          await sql`select id from bundle_events where id = ${event.id}`.execute(
            kysely,
          )
        ).rows,
      ).toEqual([]);
    } finally {
      await sql`alter table bundle_event_heads drop check reject_test_head`.execute(
        kysely,
      );
    }
    await insights.recordEvent({ event });
    await expect(
      insights.findLatestEvents({ installId: event.install_id }),
    ).resolves.toEqual([event]);
  });

  it("counts overlapping bundle predicates once, including nullable sources and moved installations", async () => {
    const { kysely } = await import("./db.js");
    const insights = kyselyAdapter({ db: kysely, provider: "mysql" }).models
      .insights;
    const overlap = {
      ...createBundleEventRowFixture("9820", 100),
      channel: "mysql-count-test",
    };
    const nullable = {
      ...overlap,
      id: createBundleEventRowFixture("9821", 100).id,
      install_id: "mysql-count-nullable",
      type: "UNCHANGED" as const,
      from_bundle_id: null,
      metadata: { ...overlap.metadata, update_strategy: null },
    };
    const otherBundle = "00000000-0000-7000-8000-000000009900";
    const fromOnly = {
      ...overlap,
      id: createBundleEventRowFixture("9822", 100).id,
      install_id: "mysql-count-from-only",
      to_bundle_id: otherBundle,
    };
    const neither = {
      ...nullable,
      id: createBundleEventRowFixture("9823", 100).id,
      install_id: "mysql-count-neither",
      to_bundle_id: otherBundle,
    };
    const superseded = {
      ...overlap,
      id: createBundleEventRowFixture("9824", 100).id,
      install_id: "mysql-count-superseded",
    };
    const moved = {
      ...overlap,
      id: createBundleEventRowFixture("9825", 100).id,
      install_id: "mysql-count-moved",
    };
    for (const event of [
      overlap,
      nullable,
      fromOnly,
      neither,
      superseded,
      moved,
      {
        ...overlap,
        id: createBundleEventRowFixture("9826", 50).id,
        install_id: "mysql-count-too-old",
        received_at_ms: 50,
      },
      {
        ...neither,
        id: createBundleEventRowFixture("9827", 200).id,
        install_id: superseded.install_id,
        received_at_ms: 200,
      },
      {
        ...moved,
        id: createBundleEventRowFixture("9828", 200).id,
        channel: "mysql-count-elsewhere",
        received_at_ms: 200,
      },
    ]) {
      await insights.recordEvent({ event });
    }
    const scope = {
      platform: overlap.platform,
      channel: overlap.channel,
      sinceMs: 100,
    };
    const from = {
      field: "from_bundle_id" as const,
      value: overlap.from_bundle_id,
      types: ["UPDATE_APPLIED", "UNCHANGED"] as const,
    };
    const to = {
      ...from,
      field: "to_bundle_id" as const,
      value: overlap.to_bundle_id,
    };
    await expect(insights.countLatestEvents(scope)).resolves.toBe(5);
    for (const bundle of [[from], [to], [from, from], [to, to]]) {
      await expect(
        insights.countLatestEvents({ ...scope, bundle }),
      ).resolves.toBe(2);
    }
    for (const bundle of [
      [from, to],
      [to, from],
    ]) {
      await expect(
        insights.countLatestEvents({ ...scope, bundle }),
      ).resolves.toBe(3);
    }
  });

  it("rejects in-place upgrade from a v0 MySQL schema", async () => {
    const database = `hot_updater_v0_${process.pid}`;
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
        create table private_hot_updater_settings (
          \`key\` varchar(255) primary key,
          value varchar(255) not null
        )
      `)
        .execute(db);
      await sql
        .raw(
          "insert into private_hot_updater_settings (`key`, value) values ('version', '0.31.0')",
        )
        .execute(db);

      const migrationHotUpdater = createHotUpdater({
        database: kyselyAdapter({ db, provider: "mysql" }),
        clientAccess: { type: "public" },
      });
      const migrator = createMigrator(migrationHotUpdater);

      await expect(
        migrator.migrateToLatest({
          mode: "from-schema",
          updateSettings: true,
        }),
      ).rejects.toThrow("Hot Updater v1 cannot migrate schema 0.31.0");
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
      const migrator = createMigrator(
        createHotUpdater({
          database: adapter,
          clientAccess: { type: "public" },
        }),
      );
      const migration = await migrator.migrateToLatest({
        mode: "from-schema",
        updateSettings: true,
      });
      await migration.execute();

      const ownerId = "fumadb-owner";
      const baseId = "fumadb-base";
      const createdChannel = await adapter.models.channels.insert({
        row: { id: "channel-production", name: "production" },
        onConflict: "returnExisting",
      });
      expect(createdChannel.inserted).toBe(true);
      const resolvedChannel = await adapter.models.channels.insert({
        row: { id: "channel-production-duplicate", name: "production" },
        onConflict: "returnExisting",
      });
      expect(resolvedChannel).toEqual({
        row: createdChannel.row,
        inserted: false,
      });
      for (const id of [baseId, ownerId]) {
        const row = createAdapterBundleRow(id);
        await expect(
          adapter.commit({
            changes: [{ model: "bundles", operation: "insert", row }],
          }),
        ).resolves.toEqual({ committed: true });
      }
      await sql`select get_lock(${gate}, 5)`.execute(control);
      await admin.query(
        `create trigger \`${database}\`.pause_fumadb_patch before insert on \`${database}\`.bundle_patches for each row set @hot_updater_patch_gate = get_lock('${gate}', 10)`,
      );

      const patchCreate = adapter.commit({
        changes: [
          {
            model: "bundlePatches",
            operation: "insert",
            row: {
              id: `${ownerId}:${baseId}`,
              bundle_id: ownerId,
              base_bundle_id: baseId,
              base_file_hash: "b".repeat(64),
              patch_file_hash: "c".repeat(64),
              patch_storage_uri: "storage://fumadb-patch",
              byte_size: 3_000_002,
              order_index: 0,
            },
          },
        ],
      });
      await waitForMySQLUserLock(admin, database);

      const deleteAdapter = kyselyAdapter({
        db: remover,
        provider: "mysql",
        relationMode: "fumadb",
      });
      let deleteSettled = false;
      const bundleDelete = deleteAdapter
        .commit({
          changes: [
            {
              model: "bundles",
              operation: "delete",
              where: { id: ownerId },
            },
          ],
        })
        .finally(() => {
          deleteSettled = true;
        });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(deleteSettled).toBe(false);

      await sql`select release_lock(${gate})`.execute(control);
      await Promise.all([patchCreate, bundleDelete]);

      await expect(
        deleteAdapter.models.bundles.findById(ownerId),
      ).resolves.toBeNull();
      await expect(
        deleteAdapter.models.bundlePatches.findByBundleIds([ownerId]),
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
  file_hash: `${id}-hash`,
  git_commit_hash: null,
  storage_uri: `storage://${id}`,
  archive_byte_size: 3_000_000_001,
  metadata: {},
  manifest_storage_uri: null,
  manifest_file_hash: null,
  asset_base_storage_uri: null,
});

const createBundleEventRowFixture = (suffix: string, receivedAtMs: number) => ({
  id: `00000000-0000-7000-8000-${suffix.padStart(12, "0")}`,
  type: "UPDATE_APPLIED" as const,
  install_id: `install-${suffix}`,
  user_id: null,
  from_release_id: null,
  from_bundle_id: "00000000-0000-7000-8000-000000009799",
  to_release_id: null,
  to_bundle_id: "00000000-0000-7000-8000-000000009800",
  platform: "ios" as const,
  app_version: "1.0.0",
  channel: "production",
  metadata: {
    username: null,
    cohort: "0",
    update_strategy: "appVersion" as const,
    fingerprint_hash: null,
    sdk_version: null,
  },
  received_at_ms: receivedAtMs,
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

const migrateCurrentSchema = async (
  hotUpdater: HotUpdaterAPI,
  projectRoot: string,
): Promise<void> => {
  const migrate = async () => {
    const migrator = createMigrator(hotUpdater);
    const result = await migrator.migrateToLatest({
      mode: "from-schema",
      updateSettings: true,
    });
    await result.execute();
  };

  try {
    await migrate();
  } catch (error) {
    if (
      !(error instanceof Error) ||
      (error.message !== "Connection lost: The server closed the connection." &&
        Reflect.get(error, "code") !== "PROTOCOL_CONNECTION_LOST")
    ) {
      throw error;
    }
    await waitForMySQLReady(projectRoot, 30);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await migrate();
  }
};

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
