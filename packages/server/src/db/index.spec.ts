import { PGlite } from "@electric-sql/pglite";
import type { Bundle } from "@hot-updater/core";
import { NIL_UUID } from "@hot-updater/core";
import { createStoragePlugin } from "@hot-updater/plugin-core";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { drizzleAdapter } from "../adapters/drizzle";
import { kyselyAdapter } from "../adapters/kysely";
import { prismaAdapter } from "../adapters/prisma";
import {
  createHotUpdater as createRuntimeHotUpdater,
  type CreateHotUpdaterOptions,
} from "../index";
import { createTableSql, hotUpdaterSchemaVersions } from "./hotUpdaterSchema";
import { createMigrator, generateSchema } from "./index";

const createHotUpdater = (
  options: Omit<CreateHotUpdaterOptions, "clientAccess">,
) =>
  createRuntimeHotUpdater({
    ...options,
    clientAccess: { type: "public" },
  });

function createTestStoragePlugin(
  protocol: string,
  readText: (storageUri: string) => Promise<string | null> = async () => null,
) {
  return createStoragePlugin({
    name: `${protocol}TestStorage`,
    protocol,
    async get({ storageUri }) {
      const text = await readText(storageUri);
      return { response: text === null ? null : new Response(text) };
    },
    async getDownloadUrl({ storageUri }) {
      const prefixes: Record<string, string> = {
        gs: "https://firebase.example.com/",
        r2: "https://r2.example.com/",
        s3: "https://s3.example.com/",
        "supabase-storage":
          "https://supabase.example.com/storage/v1/object/sign/",
      };
      return {
        url: storageUri
          .replace(`${protocol}://`, prefixes[protocol] ?? "")
          .replace(/([^:]\/)\/+/g, "$1"),
      };
    },
  });
}

describe("server/db hotUpdater (PGlite + Kysely)", async () => {
  const db = new PGlite();

  const kysely = new Kysely<object>({ dialect: new PGliteDialect(db) });
  const storageTexts = new Map<string, string | Error>();
  const readStoredText = async (storageUri: string) => {
    const text = storageTexts.get(storageUri);
    if (text instanceof Error) {
      throw text;
    }
    return text ?? null;
  };

  const hotUpdater = createHotUpdater({
    database: kyselyAdapter({
      db: kysely,
      provider: "postgresql",
    }),
    storage: [
      createTestStoragePlugin("s3", readStoredText),
      createTestStoragePlugin("r2", readStoredText),
      createTestStoragePlugin("supabase-storage", readStoredText),
      createTestStoragePlugin("gs", readStoredText),
    ],
  });
  it("uses the default generated schema artifact path for Drizzle", () => {
    const adapter = drizzleAdapter({ db: {}, provider: "sqlite" });

    expect(adapter.generateSchema?.("latest").path).toBe(
      "hot-updater-schema.ts",
    );
  });

  beforeAll(async () => {
    const migrator = createMigrator(hotUpdater);
    const result = await migrator.migrateToLatest({
      mode: "from-schema",
      updateSettings: true,
    });
    await result.execute();
  });

  beforeEach(async () => {
    storageTexts.clear();
    await db.exec("DELETE FROM release_catalogs");
    await db.exec("DELETE FROM releases");
    await db.exec("DELETE FROM bundle_patches");
    await db.exec("DELETE FROM bundles");
    await db.exec("DELETE FROM channels");
  });

  afterAll(async () => {
    await kysely.destroy();
    await db.close();
  });

  describe("schema generation", () => {
    it("passes the Prisma adapter's engine models through unchanged", () => {
      const database = prismaAdapter({ prisma: {}, provider: "postgresql" });
      const code = generateSchema(
        createHotUpdater({ database }),
        "latest",
      ).code;

      expect(code).toBe(database.generateSchema?.("latest").code);
      expect(code).toContain("model bundle_totals {");
      expect(code).toContain("model private_hot_updater_settings {");
    });

    it("rejects generating a retired schema snapshot", () => {
      const database = prismaAdapter({ prisma: {}, provider: "postgresql" });
      expect(() =>
        generateSchema(createHotUpdater({ database }), "0.21.0"),
      ).toThrow("Invalid version 0.21.0");
    });

    it("passes the Drizzle adapter's engine schema through unchanged", () => {
      const database = drizzleAdapter({ db: {}, provider: "postgresql" });
      const code = generateSchema(
        createHotUpdater({ database }),
        "latest",
      ).code;

      expect(code).toBe(database.generateSchema?.("latest").code);
      expect(code).toContain('pgTable("bundle_totals"');
      expect(code).toContain('pgTable("private_hot_updater_settings"');
    });
  });

  describe("migrator enhancements", () => {
    it("registers only the initial schema", () => {
      expect(hotUpdaterSchemaVersions.map((schema) => schema.version)).toEqual([
        "1.0.0",
      ]);
    });

    it("omits MySQL defaults for text and JSON columns", () => {
      const sql = createTableSql("mysql").join("\n");

      expect(sql).toContain("create table channels");
      expect(sql).toContain("metadata json not null");
      expect(sql).not.toContain("metadata json not null default");
      expect(sql).toContain("`key` varchar(255) primary key");
      expect(sql).not.toContain("\nkey varchar(255) primary key");
      expect(sql).toContain(
        "create table api_keys (\nid varchar(255) primary key not null",
      );
      expect(sql).not.toContain("create table api_keys (\nid text primary key");
      expect(sql).toContain(
        "create index bundle_patches_bundle_id_idx on bundle_patches(bundle_id)",
      );
      expect(sql).not.toContain("bundle_id(255)");
    });

    it("generates the engine's tables, indexes, foreign keys, and settings rows", async () => {
      const migrationDb = new PGlite();
      const migrationKysely = new Kysely<object>({
        dialect: new PGliteDialect(migrationDb),
      });
      const migrationHotUpdater = createHotUpdater({
        database: kyselyAdapter({
          db: migrationKysely,
          provider: "postgresql",
        }),
      });

      try {
        const migrator = createMigrator(migrationHotUpdater);
        const result = await migrator.migrateToLatest({
          mode: "from-schema",
          updateSettings: false,
        });
        const sql = result.getSQL?.() ?? "";

        expect(sql).toContain(
          'CREATE INDEX IF NOT EXISTS "releases_byScope" ON "releases" ("scope_key", "id")',
        );
        expect(sql).toContain(
          'ADD CONSTRAINT "bundle_patches_bundle_id_fk" FOREIGN KEY ("bundle_id") REFERENCES "bundles" ("id") ON DELETE CASCADE',
        );
        expect(sql).toContain(
          `INSERT INTO "private_hot_updater_settings" ("key", "value", "_v") VALUES ('schema.engine', '1', 0)`,
        );
        // `updateSettings: false` leaves the settings step out of the plan only
        expect(result.operations).not.toContainEqual(
          expect.objectContaining({ type: "custom" }),
        );
      } finally {
        await migrationKysely.destroy();
        await migrationDb.close();
      }
    });

    it("rejects an existing v0 Kysely schema instead of upgrading it", async () => {
      const migrationDb = new PGlite();
      const migrationKysely = new Kysely<object>({
        dialect: new PGliteDialect(migrationDb),
      });
      const migrationHotUpdater = createHotUpdater({
        database: kyselyAdapter({
          db: migrationKysely,
          provider: "postgresql",
        }),
      });

      try {
        await migrationDb.exec(`
          create table private_hot_updater_settings (
            key varchar(255) primary key,
            value text not null
          );
          insert into private_hot_updater_settings (key, value)
          values ('version', '0.21.0');
        `);

        const migrator = createMigrator(migrationHotUpdater);
        await expect(
          migrator.migrateToLatest({
            mode: "from-schema",
            updateSettings: true,
          }),
        ).rejects.toThrow("Hot Updater v1 cannot migrate schema 0.21.0");
      } finally {
        await migrationKysely.destroy();
        await migrationDb.close();
      }
    });

    it("honors soft relation mode by omitting SQL foreign keys", async () => {
      const migrationDb = new PGlite();
      const migrationKysely = new Kysely<object>({
        dialect: new PGliteDialect(migrationDb),
      });
      const migrationHotUpdater = createHotUpdater({
        database: kyselyAdapter({
          db: migrationKysely,
          provider: "postgresql",
          relationMode: "fumadb",
        }),
      });

      try {
        const migrator = createMigrator(migrationHotUpdater);
        const result = await migrator.migrateToLatest({
          mode: "from-schema",
          updateSettings: false,
        });
        const sql = result.getSQL?.() ?? "";

        expect(sql).not.toContain("add constraint bundle_patches_bundle_id_fk");
        expect(result.operations).not.toContainEqual(
          expect.objectContaining({
            sql: expect.stringContaining("bundle_patches_bundle_id_fk"),
          }),
        );
      } finally {
        await migrationKysely.destroy();
        await migrationDb.close();
      }
    });

    it("omits unsupported SQLite alter constraint statements", async () => {
      const migrationDb = new PGlite();
      const migrationKysely = new Kysely<object>({
        dialect: new PGliteDialect(migrationDb),
      });
      const migrationHotUpdater = createHotUpdater({
        database: kyselyAdapter({
          db: migrationKysely,
          provider: "sqlite",
        }),
      });

      try {
        const migrator = createMigrator(migrationHotUpdater);
        const result = await migrator.migrateToLatest({
          mode: "from-schema",
          updateSettings: false,
        });
        const sql = result.getSQL?.() ?? "";

        expect(sql).not.toContain("alter table bundles add constraint");
        expect(sql).not.toContain("alter table bundle_patches add constraint");
        expect(result.operations).not.toContainEqual(
          expect.objectContaining({
            sql: expect.stringContaining("add constraint"),
          }),
        );
      } finally {
        await migrationKysely.destroy();
        await migrationDb.close();
      }
    });

    it("rejects from-database migrations explicitly", async () => {
      const migrationDb = new PGlite();
      const migrationKysely = new Kysely<object>({
        dialect: new PGliteDialect(migrationDb),
      });
      const migrationHotUpdater = createHotUpdater({
        database: kyselyAdapter({
          db: migrationKysely,
          provider: "postgresql",
        }),
      });

      try {
        await expect(
          createMigrator(migrationHotUpdater).migrateToLatest({
            mode: "from-database",
          }),
        ).rejects.toThrow(
          "Hot Updater migrations support only mode: 'from-schema'.",
        );
      } finally {
        await migrationKysely.destroy();
        await migrationDb.close();
      }
    });

    it("rejects runtime access when a Kysely schema is not initialized", async () => {
      const migrationDb = new PGlite();
      const migrationKysely = new Kysely<object>({
        dialect: new PGliteDialect(migrationDb),
      });
      const migrationHotUpdater = createHotUpdater({
        database: kyselyAdapter({
          db: migrationKysely,
          provider: "postgresql",
        }),
      });

      try {
        await expect(
          migrationHotUpdater.getBundles({ limit: 10 }),
        ).rejects.toThrow(
          "Hot Updater database schema is not initialized for kysely.",
        );
      } finally {
        await migrationKysely.destroy();
        await migrationDb.close();
      }
    });

    it("rejects runtime access when a Kysely schema is stale", async () => {
      const migrationDb = new PGlite();
      const migrationKysely = new Kysely<object>({
        dialect: new PGliteDialect(migrationDb),
      });
      const migrationHotUpdater = createHotUpdater({
        database: kyselyAdapter({
          db: migrationKysely,
          provider: "postgresql",
        }),
      });

      try {
        await migrationDb.exec(`
          create table private_hot_updater_settings (
            key varchar(255) primary key,
            value text not null
          );
          insert into private_hot_updater_settings (key, value)
          values ('version', '0.21.0');
        `);

        await expect(migrationHotUpdater.getChannels()).rejects.toThrow(
          "Hot Updater v1 cannot migrate schema 0.21.0 in place.",
        );
      } finally {
        await migrationKysely.destroy();
        await migrationDb.close();
      }
    });
  });

  describe("adapter filters", () => {
    it("returns an empty Kysely page for empty set filters", async () => {
      const byId = await hotUpdater.getBundles({
        limit: 10,
        where: { id: { in: [] } },
      });
      expect(byId.data).toEqual([]);
      expect(byId.pagination.total).toBe(0);
    });
  });

  describe("getBundleById", () => {
    it("should retrieve bundle by id without Prisma validation errors", async () => {
      const bundle: Bundle = {
        id: "00000000-0000-0000-0000-000000000010",
        platform: "ios",
        gitCommitHash: null,
        manifestStorageUri: "s3://test-bucket/test/manifest.json",
        manifestFileHash: "test-manifest-hash",
        assetBaseStorageUri: "s3://test-bucket/assets",
      };

      await hotUpdater.insertBundle(bundle);

      // This should not throw a Prisma validation error
      const retrieved = await hotUpdater.getBundleById(bundle.id);

      expect(retrieved).not.toBeNull();
      expect(retrieved?.id).toBe(bundle.id);
      expect(retrieved?.platform).toBe(bundle.platform);
      expect(retrieved?.manifestFileHash).toBe(bundle.manifestFileHash);
    });

    it("should return null for non-existent bundle id", async () => {
      const retrieved = await hotUpdater.getBundleById(
        "99999999-9999-9999-9999-999999999999",
      );

      expect(retrieved).toBeNull();
    });
  });

  describe("getChannels", () => {
    it("retrieves canonical Channel rows without Prisma validation errors", async () => {
      await hotUpdater.insertChannel({
        onConflict: "returnExisting",
        row: { id: "channel-production", name: "production" },
      });
      await hotUpdater.insertChannel({
        onConflict: "returnExisting",
        row: { id: "channel-staging", name: "staging" },
      });

      const channels = await hotUpdater.getChannels();

      expect(channels).toHaveLength(2);
      expect(channels.map(({ name }) => name)).toEqual([
        "production",
        "staging",
      ]);
    });

    it("should return empty array when no bundles exist", async () => {
      const channels = await hotUpdater.getChannels();
      expect(channels).toEqual([]);
    });
  });

  describe("getArtifactInfo with storage plugins", () => {
    beforeEach(() => {
      // Fix time for deterministic signed URLs
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2025-10-15T12:21:00Z"));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("resolves manifest and asset URIs via s3StoragePlugin", async () => {
      const bundle: Bundle = {
        id: "00000000-0000-0000-0000-000000000001",
        platform: "ios",
        gitCommitHash: null,
        manifestStorageUri: "s3://test-bucket/bundles/bundle/manifest.json",
        manifestFileHash: "manifest-hash",
        assetBaseStorageUri: "s3://test-bucket/assets",
      };
      storageTexts.set(
        bundle.manifestStorageUri,
        JSON.stringify({
          bundleId: bundle.id,
          assets: { "assets/logo.png": { fileHash: "logo-hash" } },
        }),
      );

      await hotUpdater.insertBundle(bundle);

      const updateInfo = await hotUpdater.getArtifactInfo(
        bundle.id,
        NIL_UUID,
        1,
      );

      expect(updateInfo).not.toBeNull();
      expect(updateInfo?.manifestUrl).toBe(
        "https://s3.example.com/test-bucket/bundles/bundle/manifest.json",
      );
    });

    it("returns manifest metadata and hbc patch descriptors", async () => {
      const currentManifestStorageUri =
        "s3://test-bucket/releases/bundles/00000000-0000-0000-0000-000000000101/manifest.json";
      const nextManifestStorageUri =
        "s3://test-bucket/releases/bundles/00000000-0000-0000-0000-000000000102/manifest.json";
      const olderBundle: Bundle = {
        id: "00000000-0000-0000-0000-000000000100",
        platform: "ios",
        gitCommitHash: null,
        assetBaseStorageUri: "s3://test-bucket/releases/assets",
        manifestFileHash: "manifest-older",
        manifestStorageUri:
          "s3://test-bucket/releases/bundles/00000000-0000-0000-0000-000000000100/manifest.json",
      };
      const currentBundle: Bundle = {
        id: "00000000-0000-0000-0000-000000000101",
        platform: "ios",
        gitCommitHash: null,
        assetBaseStorageUri: "s3://test-bucket/releases/assets",
        manifestFileHash: "sig:manifest-current",
        manifestStorageUri: currentManifestStorageUri,
      };
      const nextBundle: Bundle = {
        id: "00000000-0000-0000-0000-000000000102",
        platform: "ios",
        gitCommitHash: null,
        assetBaseStorageUri: "s3://test-bucket/releases/assets",
        manifestFileHash: "sig:manifest-next",
        manifestStorageUri: nextManifestStorageUri,
        patches: [
          {
            baseBundleId: "00000000-0000-0000-0000-000000000100",
            baseFileHash: "hash-older-bundle",
            byteSize: 48,
            patchFileHash: "hash-older-bsdiff",
            patchStorageUri:
              "s3://test-bucket/releases/bundles/00000000-0000-0000-0000-000000000102/patches/00000000-0000-0000-0000-000000000100/index.ios.bundle.bsdiff",
          },
          {
            baseBundleId: currentBundle.id,
            baseFileHash: "hash-old-bundle",
            byteSize: 48,
            patchFileHash: "hash-bsdiff",
            patchStorageUri:
              "s3://test-bucket/releases/bundles/00000000-0000-0000-0000-000000000102/patches/00000000-0000-0000-0000-000000000101/index.ios.bundle.bsdiff",
          },
        ],
      };
      storageTexts.set(
        currentManifestStorageUri,
        JSON.stringify({
          assets: {
            "assets/logo.png": {
              fileHash: "hash-logo",
            },
            "index.ios.bundle": {
              fileHash: "hash-old-bundle",
            },
          },
          bundleId: currentBundle.id,
        }),
      );
      storageTexts.set(
        nextManifestStorageUri,
        JSON.stringify({
          assets: {
            "assets/logo.png": {
              fileHash: "hash-logo",
            },
            "index.ios.bundle": {
              fileHash: "hash-new-bundle",
            },
          },
          bundleId: nextBundle.id,
        }),
      );
      const fetchMock = vi.fn<typeof fetch>(async () => {
        return new Response("manifest fetch should not be used", {
          status: 500,
        });
      });

      await hotUpdater.insertBundle(olderBundle);
      await hotUpdater.insertBundle(currentBundle);
      await hotUpdater.insertBundle(nextBundle);
      vi.stubGlobal("fetch", fetchMock);

      try {
        await expect(
          hotUpdater.getArtifactInfo(nextBundle.id, currentBundle.id, 1),
        ).resolves.toMatchObject({
          artifactProtocolVersion: 1,
          assets: {
            "assets/logo.png": {
              file: { url: expect.any(String) },
              fileHash: "hash-logo",
            },
            "index.ios.bundle": {
              file: { url: expect.any(String) },
              fileHash: "hash-new-bundle",
            },
          },
          manifestFileHash: "sig:manifest-next",
          manifestUrl:
            "https://s3.example.com/test-bucket/releases/bundles/00000000-0000-0000-0000-000000000102/manifest.json",
        });
        expect(fetchMock).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("propagates manifest storage read failures", async () => {
      const nextManifestStorageUri =
        "s3://test-bucket/releases/bundles/00000000-0000-0000-0000-000000000109/manifest.json";
      const nextBundle: Bundle = {
        id: "00000000-0000-0000-0000-000000000109",
        platform: "ios",
        gitCommitHash: null,
        assetBaseStorageUri: "s3://test-bucket/releases/assets",
        manifestFileHash: "sig:manifest-next",
        manifestStorageUri: nextManifestStorageUri,
      };

      await hotUpdater.insertBundle(nextBundle);
      storageTexts.set(
        nextManifestStorageUri,
        new Error("storage read failed"),
      );

      await expect(
        hotUpdater.getArtifactInfo(nextBundle.id, NIL_UUID, 1),
      ).rejects.toThrow("storage read failed");
    });
  });
});
