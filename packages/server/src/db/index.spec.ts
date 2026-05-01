import { PGlite } from "@electric-sql/pglite";
import type { Bundle, GetBundlesArgs, UpdateInfo } from "@hot-updater/core";
import { NIL_UUID } from "@hot-updater/core";
import type {
  StoragePlugin,
  StorageResolveContext,
} from "@hot-updater/plugin-core";
import { createDatabasePlugin } from "@hot-updater/plugin-core";
import {
  setupBundleMethodsTestSuite,
  setupGetUpdateInfoTestSuite,
} from "@hot-updater/test-utils";
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

import { kyselyAdapter } from "../adapters/kysely";
import { createHotUpdater } from "./index";
import type { ORMDatabaseAdapter, ORMProvider } from "./types";

const RAW_PRISMA_SCHEMA = `model bundles {
  id String @id
  platform String
  should_force_update Boolean
  enabled Boolean
  file_hash String
  git_commit_hash String?
  message String?
  channel String @default("production")
  storage_uri String
  target_app_version String?
  fingerprint_hash String?
  metadata Json
  manifest_storage_uri String?
  manifest_file_hash String?
  asset_base_storage_uri String?
  rollout_cohort_count Int @default(1000)
  target_cohorts Json?
}
model bundle_patches {
  id String @id
  bundle_id String
  base_bundle_id String
  base_file_hash String
  patch_file_hash String
  patch_storage_uri String
  order_index Int @default(0)
  bundle bundles @relation("bundle_patches_bundles_patches", fields: [bundle_id], references: [id], onUpdate: Restrict, onDelete: Cascade)
  baseBundle bundles @relation("bundle_patches_bundles_baseForPatches", fields: [base_bundle_id], references: [id], onUpdate: Restrict, onDelete: Cascade)
}
model private_hot_updater_settings {
  key String @id
  value String @default("0.31.0")
}`;

const RAW_DRIZZLE_SCHEMA = `import { relations } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  boolean,
  json,
  integer,
  varchar,
  foreignKey,
} from "drizzle-orm/pg-core";

export const bundles = pgTable("bundles", {
  id: uuid("id").primaryKey().notNull(),
  platform: text("platform").notNull(),
  should_force_update: boolean("should_force_update").notNull(),
  enabled: boolean("enabled").notNull(),
  file_hash: text("file_hash").notNull(),
  git_commit_hash: text("git_commit_hash"),
  message: text("message"),
  channel: text("channel").notNull().default("production"),
  storage_uri: text("storage_uri").notNull(),
  target_app_version: text("target_app_version"),
  fingerprint_hash: text("fingerprint_hash"),
  metadata: json("metadata").notNull(),
  manifest_storage_uri: text("manifest_storage_uri"),
  manifest_file_hash: text("manifest_file_hash"),
  asset_base_storage_uri: text("asset_base_storage_uri"),
  rollout_cohort_count: integer("rollout_cohort_count")
    .notNull()
    .default(1000),
  target_cohorts: json("target_cohorts"),
})

export const bundle_patches = pgTable(
  "bundle_patches",
  {
    id: varchar("id", { length: 255 }).primaryKey().notNull(),
    bundle_id: uuid("bundle_id").notNull(),
    base_bundle_id: uuid("base_bundle_id").notNull(),
    base_file_hash: text("base_file_hash").notNull(),
    patch_file_hash: text("patch_file_hash").notNull(),
    patch_storage_uri: text("patch_storage_uri").notNull(),
    order_index: integer("order_index").notNull().default(0),
  }, (table) => [
    foreignKey({
      columns: [table.bundle_id],
      foreignColumns: [bundles.id],
      name: "bundle_patches_bundle_id_fk",
    })
      .onUpdate("restrict")
      .onDelete("cascade"),
    foreignKey({
      columns: [table.base_bundle_id],
      foreignColumns: [bundles.id],
      name: "bundle_patches_base_bundle_id_fk",
    })
      .onUpdate("restrict")
      .onDelete("cascade"),
])

export const bundle_patchesRelations = relations(bundle_patches, ({ one, many }) => ({
  bundle: one(bundles, {
    relationName: "bundle_patches_bundles_patches",
    fields: [bundle_patches.bundle_id],
    references: [bundles.id],
  }),
  baseBundle: one(bundles, {
    relationName: "bundle_patches_bundles_baseForPatches",
    fields: [bundle_patches.base_bundle_id],
    references: [bundles.id],
  }),
}));`;

function createTestStoragePlugin(
  protocol: string,
  resolveFileUrl: (
    storageUri: string,
    context?: StorageResolveContext,
  ) => string,
): StoragePlugin {
  return {
    name: `${protocol}TestStorage`,
    supportedProtocol: protocol,
    async upload(key) {
      return {
        storageUri: `${protocol}://test-bucket/${key}`,
      };
    },
    async delete() {},
    async download() {},
    async getDownloadUrl(storageUri, context) {
      return { fileUrl: resolveFileUrl(storageUri, context) };
    },
  };
}

function createSchemaOnlyAdapter({
  code,
  name,
  provider,
  path,
}: {
  code: string;
  name: string;
  provider: ORMProvider;
  path: string;
}): ORMDatabaseAdapter {
  return {
    name,
    provider,
    createORM() {
      throw new Error("Schema-only adapter cannot create ORM");
    },
    async getSchemaVersion() {
      return undefined;
    },
    generateSchema(_schema, schemaName) {
      return {
        code,
        path: path || schemaName,
      };
    },
  };
}

describe("server/db hotUpdater getUpdateInfo (PGlite + Kysely)", async () => {
  const db = new PGlite();

  const kysely = new Kysely({ dialect: new PGliteDialect(db) });

  const hotUpdater = createHotUpdater({
    database: kyselyAdapter({
      db: kysely,
      provider: "postgresql",
    }),
    storages: [
      createTestStoragePlugin("s3", (storageUri) =>
        storageUri
          .replace("s3://", "https://s3.example.com/")
          .replace(/([^:]\/)\/+/g, "$1"),
      ),
      createTestStoragePlugin("r2", (storageUri) =>
        storageUri
          .replace("r2://", "https://r2.example.com/")
          .replace(/([^:]\/)\/+/g, "$1"),
      ),
      createTestStoragePlugin("supabase-storage", (storageUri) =>
        storageUri
          .replace(
            "supabase-storage://",
            "https://supabase.example.com/storage/v1/object/sign/",
          )
          .replace(/([^:]\/)\/+/g, "$1"),
      ),
      createTestStoragePlugin("gs", (storageUri) =>
        storageUri
          .replace("gs://", "https://firebase.example.com/")
          .replace(/([^:]\/)\/+/g, "$1"),
      ),
    ],
  });
  const prismaSchemaHotUpdater = createHotUpdater({
    database: createSchemaOnlyAdapter({
      code: RAW_PRISMA_SCHEMA,
      name: "prisma",
      path: "schema.prisma",
      provider: "postgresql",
    }),
  });
  const sqlitePrismaSchemaHotUpdater = createHotUpdater({
    database: createSchemaOnlyAdapter({
      code: RAW_PRISMA_SCHEMA,
      name: "prisma",
      path: "schema.prisma",
      provider: "sqlite",
    }),
  });
  const drizzleSchemaHotUpdater = createHotUpdater({
    database: createSchemaOnlyAdapter({
      code: RAW_DRIZZLE_SCHEMA,
      name: "drizzle",
      path: "hot-updater-schema.ts",
      provider: "postgresql",
    }),
  });

  beforeAll(async () => {
    // Initialize FumaDB schema to latest (creates tables under the hood)
    const migrator = hotUpdater.createMigrator();
    const result = await migrator.migrateToLatest({
      mode: "from-schema",
      updateSettings: true,
    });
    await result.execute();
  });

  beforeEach(async () => {
    await db.exec("DELETE FROM bundle_patches");
    await db.exec("DELETE FROM bundles");
  });

  afterAll(async () => {
    await kysely.destroy();
    await db.close();
  });

  const getUpdateInfo = async (
    bundles: Bundle[],
    options: GetBundlesArgs,
  ): Promise<UpdateInfo | null> => {
    // Insert fixtures via the server API to exercise its types + mapping
    for (const b of bundles) {
      await hotUpdater.insertBundle(b);
    }
    return hotUpdater.getUpdateInfo(options);
  };

  setupGetUpdateInfoTestSuite({ getUpdateInfo });
  setupBundleMethodsTestSuite({
    getBundleById: hotUpdater.getBundleById.bind(hotUpdater),
    getChannels: hotUpdater.getChannels.bind(hotUpdater),
    insertBundle: hotUpdater.insertBundle.bind(hotUpdater),
    getBundles: hotUpdater.getBundles.bind(hotUpdater),
    updateBundleById: hotUpdater.updateBundleById.bind(hotUpdater),
    deleteBundleById: hotUpdater.deleteBundleById.bind(hotUpdater),
  });

  describe("schema generation", () => {
    it("includes relations, defaults, and indexes in Prisma output", () => {
      const code = prismaSchemaHotUpdater.generateSchema("latest").code;

      expect(code).toContain('channel String @default("production")');
      expect(code).toContain('metadata Json @default("{}")');
      expect(code).toContain(
        'patches bundle_patches[] @relation("bundle_patches_bundles_patches")',
      );
      expect(code).toContain(
        'baseForPatches bundle_patches[] @relation("bundle_patches_bundles_baseForPatches")',
      );
      expect(code).toContain(
        'bundle bundles @relation("bundle_patches_bundles_patches"',
      );
      expect(code).toContain(
        'baseBundle bundles @relation("bundle_patches_bundles_baseForPatches"',
      );
      expect(code).toContain('@@index([channel], map: "bundles_channel_idx")');
      expect(code).toContain(
        '@@index([bundle_id], map: "bundle_patches_bundle_id_idx")',
      );
    });

    it("omits the metadata JSON default for SQLite Prisma output", () => {
      const code = sqlitePrismaSchemaHotUpdater.generateSchema("latest").code;

      expect(code).toContain("metadata Json");
      expect(code).not.toContain('metadata Json @default("{}")');
    });

    it("includes foreign keys and indexes in Drizzle output", () => {
      const code = drizzleSchemaHotUpdater.generateSchema("latest").code;
      const bundlesBlock = code.match(
        /export const bundles = [\s\S]*?(?=\n\nexport const bundle_patches = )/,
      )?.[0];
      const bundlePatchesBlock = code.match(
        /export const bundle_patches = [\s\S]*?(?=\n\nexport const bundle_patchesRelations = )/,
      )?.[0];

      expect(code).toContain(
        'channel: text("channel").notNull().default("production")',
      );
      expect(code).toContain(
        'metadata: json("metadata").notNull().default({})',
      );
      expect(code).toContain('name: "bundle_patches_bundle_id_fk"');
      expect(code).toContain('name: "bundle_patches_base_bundle_id_fk"');
      expect(bundlesBlock).toContain(
        'index("bundles_channel_idx").on(table.channel)',
      );
      expect(bundlesBlock).toContain(
        'index("bundles_target_app_version_idx").on(table.target_app_version)',
      );
      expect(bundlesBlock).not.toContain(
        'index("bundle_patches_bundle_id_idx").on(table.bundle_id)',
      );
      expect(bundlePatchesBlock).toContain(
        'index("bundle_patches_bundle_id_idx").on(table.bundle_id)',
      );
      expect(bundlePatchesBlock).not.toContain(
        'index("bundles_target_app_version_idx").on(table.target_app_version)',
      );
    });
  });

  describe("migrator enhancements", () => {
    it("adds custom indexes and constraints to generated SQL", async () => {
      const migrationDb = new PGlite();
      const migrationKysely = new Kysely({
        dialect: new PGliteDialect(migrationDb),
      });
      const migrationHotUpdater = createHotUpdater({
        database: kyselyAdapter({
          db: migrationKysely,
          provider: "postgresql",
        }),
      });

      try {
        const migrator = migrationHotUpdater.createMigrator();
        const result = await migrator.migrateToLatest({
          mode: "from-schema",
          updateSettings: false,
        });
        const sql = result.getSQL?.() ?? "";

        expect(sql).toContain("create index bundles_channel_idx on bundles");
        expect(sql).toContain(
          "add constraint check_version_or_fingerprint check",
        );
        expect(sql).toContain(
          "create index bundle_patches_bundle_id_idx on bundle_patches",
        );
      } finally {
        await migrationKysely.destroy();
        await migrationDb.close();
      }
    });
  });

  describe("bundle validation", () => {
    it("rejects bundles without targeting information", async () => {
      await expect(
        hotUpdater.insertBundle({
          id: "00000000-0000-0000-0000-000000000999",
          platform: "ios",
          shouldForceUpdate: false,
          enabled: true,
          fileHash: "missing-target",
          gitCommitHash: null,
          message: null,
          channel: "production",
          storageUri: "s3://test-bucket/missing-target.zip",
          targetAppVersion: null,
          fingerprintHash: null,
        }),
      ).rejects.toThrow(
        "Bundle must define either targetAppVersion or fingerprintHash.",
      );
    });
  });

  describe("getBundleById", () => {
    it("should retrieve bundle by id without Prisma validation errors", async () => {
      const bundle: Bundle = {
        id: "00000000-0000-0000-0000-000000000010",
        platform: "ios",
        shouldForceUpdate: false,
        enabled: true,
        fileHash: "test-hash",
        gitCommitHash: null,
        message: "Test bundle for getBundleById",
        channel: "production",
        storageUri: "s3://test-bucket/test.zip",
        targetAppVersion: "1.0.0",
        fingerprintHash: null,
      };

      await hotUpdater.insertBundle(bundle);

      // This should not throw a Prisma validation error
      const retrieved = await hotUpdater.getBundleById(bundle.id);

      expect(retrieved).not.toBeNull();
      expect(retrieved?.id).toBe(bundle.id);
      expect(retrieved?.platform).toBe(bundle.platform);
      expect(retrieved?.fileHash).toBe(bundle.fileHash);
    });

    it("should return null for non-existent bundle id", async () => {
      const retrieved = await hotUpdater.getBundleById(
        "99999999-9999-9999-9999-999999999999",
      );

      expect(retrieved).toBeNull();
    });
  });

  describe("getChannels", () => {
    it("should retrieve all unique channels without Prisma validation errors", async () => {
      const bundles: Bundle[] = [
        {
          id: "00000000-0000-0000-0000-000000000020",
          platform: "ios",
          shouldForceUpdate: false,
          enabled: true,
          fileHash: "hash1",
          gitCommitHash: null,
          message: "Bundle 1",
          channel: "production",
          storageUri: "s3://test/1.zip",
          targetAppVersion: "1.0.0",
          fingerprintHash: null,
        },
        {
          id: "00000000-0000-0000-0000-000000000021",
          platform: "android",
          shouldForceUpdate: false,
          enabled: true,
          fileHash: "hash2",
          gitCommitHash: null,
          message: "Bundle 2",
          channel: "staging",
          storageUri: "s3://test/2.zip",
          targetAppVersion: "1.0.0",
          fingerprintHash: null,
        },
        {
          id: "00000000-0000-0000-0000-000000000022",
          platform: "ios",
          shouldForceUpdate: false,
          enabled: true,
          fileHash: "hash3",
          gitCommitHash: null,
          message: "Bundle 3",
          channel: "production",
          storageUri: "s3://test/3.zip",
          targetAppVersion: "1.0.0",
          fingerprintHash: null,
        },
      ];

      for (const bundle of bundles) {
        await hotUpdater.insertBundle(bundle);
      }

      // This should not throw a Prisma validation error
      const channels = await hotUpdater.getChannels();

      expect(channels).toHaveLength(2);
      expect(channels).toContain("production");
      expect(channels).toContain("staging");
    });

    it("should return empty array when no bundles exist", async () => {
      const channels = await hotUpdater.getChannels();
      expect(channels).toEqual([]);
    });
  });

  describe("getAppUpdateInfo with storage plugins", () => {
    beforeEach(() => {
      // Fix time for deterministic signed URLs
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2025-10-15T12:21:00Z"));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("resolves s3:// storage URI to signed URL via s3StoragePlugin", async () => {
      const bundle: Bundle = {
        id: "00000000-0000-0000-0000-000000000001",
        platform: "ios",
        shouldForceUpdate: false,
        enabled: true,
        fileHash: "hash123",
        gitCommitHash: null,
        message: "Test bundle",
        channel: "production",
        storageUri: "s3://test-bucket/bundles/bundle.zip",
        targetAppVersion: "1.0.0",
        fingerprintHash: null,
      };

      await hotUpdater.insertBundle(bundle);

      const updateInfo = await hotUpdater.getAppUpdateInfo({
        appVersion: "1.0.0",
        bundleId: NIL_UUID,
        platform: "ios",
        _updateStrategy: "appVersion",
      });

      expect(updateInfo).not.toBeNull();
      expect(updateInfo?.fileUrl).toBe(
        "https://s3.example.com/test-bucket/bundles/bundle.zip",
      );
    });

    it("passes through http:// URLs without plugin resolution", async () => {
      const bundle: Bundle = {
        id: "00000000-0000-0000-0000-000000000004",
        platform: "ios",
        shouldForceUpdate: false,
        enabled: true,
        fileHash: "hashhttp",
        gitCommitHash: null,
        message: "HTTP bundle",
        channel: "production",
        storageUri: "s3://bundle/bundle.zip",
        targetAppVersion: "1.0.0",
        fingerprintHash: null,
      };

      await hotUpdater.insertBundle(bundle);

      const updateInfo = await hotUpdater.getAppUpdateInfo({
        appVersion: "1.0.0",
        bundleId: NIL_UUID,
        platform: "ios",
        _updateStrategy: "appVersion",
      });

      expect(updateInfo).not.toBeNull();
      expect(updateInfo?.fileUrl).toBe(
        "https://s3.example.com/bundle/bundle.zip",
      );
    });

    it("passes through https:// URLs without plugin resolution", async () => {
      const bundle: Bundle = {
        id: "00000000-0000-0000-0000-000000000005",
        platform: "ios",
        shouldForceUpdate: false,
        enabled: true,
        fileHash: "hashhttps",
        gitCommitHash: null,
        message: "HTTPS bundle",
        channel: "production",
        storageUri: "https://cdn.example.com/bundle.zip",
        targetAppVersion: "1.0.0",
        fingerprintHash: null,
      };

      await hotUpdater.insertBundle(bundle);

      const updateInfo = await hotUpdater.getAppUpdateInfo({
        appVersion: "1.0.0",
        bundleId: NIL_UUID,
        platform: "ios",
        _updateStrategy: "appVersion",
      });

      expect(updateInfo).not.toBeNull();
      expect(updateInfo?.fileUrl).toBe("https://cdn.example.com/bundle.zip");
    });

    it("returns null when no update is available", async () => {
      const updateInfo = await hotUpdater.getAppUpdateInfo({
        appVersion: "99.0.0",
        bundleId: NIL_UUID,
        platform: "ios",
        _updateStrategy: "appVersion",
      });

      expect(updateInfo).toBeNull();
    });

    it("works with fingerprint strategy", async () => {
      const bundle: Bundle = {
        id: "00000000-0000-0000-0000-000000000008",
        platform: "ios",
        shouldForceUpdate: false,
        enabled: true,
        fileHash: "hashfp",
        gitCommitHash: null,
        message: "Fingerprint bundle",
        channel: "production",
        storageUri: "s3://test-bucket/fp-bundle.zip",
        targetAppVersion: null,
        fingerprintHash: "fingerprint123",
      };

      await hotUpdater.insertBundle(bundle);

      const updateInfo = await hotUpdater.getAppUpdateInfo({
        fingerprintHash: "fingerprint123",
        bundleId: NIL_UUID,
        platform: "ios",
        _updateStrategy: "fingerprint",
      });

      expect(updateInfo).not.toBeNull();
      expect(updateInfo?.fileUrl).toBe(
        "https://s3.example.com/test-bucket/fp-bundle.zip",
      );
    });

    it("returns manifest metadata and hbc patch descriptors for createHotUpdater", async () => {
      const olderBundle: Bundle = {
        id: "00000000-0000-0000-0000-000000000100",
        platform: "ios",
        shouldForceUpdate: false,
        enabled: true,
        fileHash: "hash-older-zip",
        gitCommitHash: null,
        message: "Older bundle",
        channel: "production",
        storageUri:
          "s3://test-bucket/releases/00000000-0000-0000-0000-000000000100/bundle.zip",
        targetAppVersion: "1.0.0",
        fingerprintHash: null,
      };
      const currentBundle: Bundle = {
        id: "00000000-0000-0000-0000-000000000101",
        platform: "ios",
        shouldForceUpdate: false,
        enabled: true,
        fileHash: "hash-current-zip",
        gitCommitHash: null,
        message: "Current bundle",
        channel: "production",
        storageUri:
          "s3://test-bucket/releases/00000000-0000-0000-0000-000000000101/bundle.zip",
        targetAppVersion: "1.0.0",
        fingerprintHash: null,
        metadata: {
          asset_base_storage_uri:
            "s3://test-bucket/releases/00000000-0000-0000-0000-000000000101/files",
          manifest_file_hash: "sig:manifest-current",
          manifest_storage_uri:
            "s3://test-bucket/releases/00000000-0000-0000-0000-000000000101/manifest.json",
        },
      };
      const nextBundle: Bundle = {
        id: "00000000-0000-0000-0000-000000000102",
        platform: "ios",
        shouldForceUpdate: false,
        enabled: true,
        fileHash: "hash-next-zip",
        gitCommitHash: null,
        message: "Next bundle",
        channel: "production",
        storageUri:
          "s3://test-bucket/releases/00000000-0000-0000-0000-000000000102/bundle.zip",
        targetAppVersion: "1.0.0",
        fingerprintHash: null,
        metadata: {
          asset_base_storage_uri:
            "s3://test-bucket/releases/00000000-0000-0000-0000-000000000102/files",
          patches: {
            [currentBundle.id]: {
              base_file_hash: "hash-old-bundle",
              patch_file_hash: "hash-bsdiff",
              patch_storage_uri:
                "s3://test-bucket/releases/00000000-0000-0000-0000-000000000102/patches/00000000-0000-0000-0000-000000000101/index.ios.bundle.bsdiff",
            },
            "00000000-0000-0000-0000-000000000100": {
              base_file_hash: "hash-older-bundle",
              patch_file_hash: "hash-older-bsdiff",
              patch_storage_uri:
                "s3://test-bucket/releases/00000000-0000-0000-0000-000000000102/patches/00000000-0000-0000-0000-000000000100/index.ios.bundle.bsdiff",
            },
          },
          manifest_file_hash: "sig:manifest-next",
          manifest_storage_uri:
            "s3://test-bucket/releases/00000000-0000-0000-0000-000000000102/manifest.json",
        },
        patchBaseBundleId: "00000000-0000-0000-0000-000000000100",
        patchBaseFileHash: "hash-older-bundle",
        patchFileHash: "hash-older-bsdiff",
        patchStorageUri:
          "s3://test-bucket/releases/00000000-0000-0000-0000-000000000102/patches/00000000-0000-0000-0000-000000000100/index.ios.bundle.bsdiff",
      };
      const fetchMock = vi.fn<typeof fetch>(async (input) => {
        const url = String(input);

        if (url.endsWith(`${currentBundle.id}/manifest.json`)) {
          return new Response(
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
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }

        if (url.endsWith(`${nextBundle.id}/manifest.json`)) {
          return new Response(
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
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }

        return new Response("not found", { status: 404 });
      });

      await hotUpdater.insertBundle(olderBundle);
      await hotUpdater.insertBundle(currentBundle);
      await hotUpdater.insertBundle(nextBundle);
      vi.stubGlobal("fetch", fetchMock);

      try {
        await expect(
          hotUpdater.getAppUpdateInfo({
            appVersion: "1.0.0",
            bundleId: currentBundle.id,
            channel: "production",
            platform: "ios",
            _updateStrategy: "appVersion",
          }),
        ).resolves.toEqual({
          changedAssets: {
            "index.ios.bundle": {
              fileHash: "hash-new-bundle",
              patch: {
                algorithm: "bsdiff",
                baseBundleId: currentBundle.id,
                baseFileHash: "hash-old-bundle",
                patchFileHash: "hash-bsdiff",
                patchUrl:
                  "https://s3.example.com/test-bucket/releases/00000000-0000-0000-0000-000000000102/patches/00000000-0000-0000-0000-000000000101/index.ios.bundle.bsdiff",
              },
              fileUrl:
                "https://s3.example.com/test-bucket/releases/00000000-0000-0000-0000-000000000102/files/index.ios.bundle",
            },
          },
          fileHash: "hash-next-zip",
          fileUrl:
            "https://s3.example.com/test-bucket/releases/00000000-0000-0000-0000-000000000102/bundle.zip",
          id: nextBundle.id,
          manifestFileHash: "sig:manifest-next",
          manifestUrl:
            "https://s3.example.com/test-bucket/releases/00000000-0000-0000-0000-000000000102/manifest.json",
          message: "Next bundle",
          shouldForceUpdate: false,
          status: "UPDATE",
        });
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });

  describe("database plugin factories", () => {
    it("isolates pending mutation state between overlapping writes", async () => {
      const committedBundleIds: string[][] = [];
      const onUnmount = vi.fn(async () => undefined);
      let releaseFirstCommit!: () => void;
      let notifyFirstCommitStarted!: () => void;
      const firstCommitStarted = new Promise<void>((resolve) => {
        notifyFirstCommitStarted = resolve;
      });
      const firstCommitGate = new Promise<void>((resolve) => {
        releaseFirstCommit = resolve;
      });
      let commitCount = 0;

      const isolatedHotUpdater = createHotUpdater({
        database: createDatabasePlugin({
          name: "isolatedPlugin",
          factory: () => ({
            async getBundleById() {
              return null;
            },
            async getBundles() {
              return {
                data: [],
                pagination: {
                  hasNextPage: false,
                  hasPreviousPage: false,
                  currentPage: 1,
                  totalPages: 1,
                  total: 0,
                },
              };
            },
            async getChannels() {
              return [];
            },
            onUnmount,
            async commitBundle({ changedSets }) {
              commitCount += 1;
              committedBundleIds.push(
                changedSets.map((change) => change.data.id),
              );

              if (commitCount === 1) {
                notifyFirstCommitStarted();
                await firstCommitGate;
              }
            },
          }),
        })({}),
      });

      const firstBundleId = "00000000-0000-0000-0000-000000000030";
      const secondBundleId = "00000000-0000-0000-0000-000000000031";

      const firstInsert = isolatedHotUpdater.insertBundle({
        id: firstBundleId,
        platform: "ios",
        shouldForceUpdate: false,
        enabled: true,
        fileHash: "hash-1",
        gitCommitHash: null,
        message: "first bundle",
        channel: "production",
        storageUri: "s3://test-bucket/first.zip",
        targetAppVersion: "1.0.0",
        fingerprintHash: null,
      });
      await firstCommitStarted;

      const secondInsert = isolatedHotUpdater.insertBundle({
        id: secondBundleId,
        platform: "ios",
        shouldForceUpdate: false,
        enabled: true,
        fileHash: "hash-2",
        gitCommitHash: null,
        message: "second bundle",
        channel: "production",
        storageUri: "s3://test-bucket/second.zip",
        targetAppVersion: "1.0.0",
        fingerprintHash: null,
      });

      releaseFirstCommit();
      await Promise.all([firstInsert, secondInsert]);

      expect(committedBundleIds).toEqual([[firstBundleId], [secondBundleId]]);
    });
  });
});
