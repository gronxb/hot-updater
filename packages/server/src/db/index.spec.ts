import { PGlite } from "@electric-sql/pglite";
import type { Bundle } from "@hot-updater/core";
import { NIL_UUID } from "@hot-updater/core";
import { createStoragePlugin } from "@hot-updater/plugin-core";
import { sql } from "drizzle-orm";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import { type ClientSession, MongoClient } from "mongodb";
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

import { createInMemoryDatabasePlugin } from "../../../test-utils/test/inMemoryDatabasePlugin";
import { drizzleAdapter } from "../adapters/drizzle";
import { kyselyAdapter } from "../adapters/kysely";
import { mongoAdapter } from "../adapters/mongodb";
import { prismaAdapter } from "../adapters/prisma";
import {
  createHotUpdater as createRuntimeHotUpdater,
  type CreateHotUpdaterOptions,
} from "../index";
import { bundleToRow } from "./bundleRows";
import { createTableSql, hotUpdaterSchemaVersions } from "./hotUpdaterSchema";
import { createMigrator, generateSchema } from "./index";
import { generateDrizzleSchema } from "./schemaGenerators";
import type { DatabasePlugin, ORMProvider } from "./types";

const createHotUpdater = (
  options: Omit<CreateHotUpdaterOptions, "clientAccess">,
) =>
  createRuntimeHotUpdater({
    ...options,
    clientAccess: { type: "public" },
  });

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
  value String @default("0.36.0")
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

export const private_hot_updater_settings = pgTable("private_hot_updater_settings", {
  key: varchar("key", { length: 255 }).primaryKey().notNull(),
  version: varchar("version", { length: 255 }).notNull().default("0.36.0"),
})

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
}): DatabasePlugin {
  return {
    ...createInMemoryDatabasePlugin(),
    adapterName: name,
    provider,
    generateSchema: (_version, schemaName = name) => ({
      code,
      path: path || schemaName,
    }),
  };
}

const transactionBundle: Bundle = {
  archiveByteSize: 1_024,
  id: "00000000-0000-0000-0000-000000000777",
  platform: "ios",
  fileHash: "transaction-hash",
  gitCommitHash: null,
  storageUri: "s3://test-bucket/transaction.zip",
};
const transactionChannelId = "00000000-0000-0000-0000-000000000700";

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

  it("uses the default generated schema artifact path for Drizzle", () => {
    const adapter = drizzleAdapter({
      db: {
        _: {
          fullSchema: {
            bundle_patches: {},
            bundles: {},
          },
        },
        $count: vi.fn(),
        delete: vi.fn(),
        insert: vi.fn(),
        query: {
          bundle_patches: { findFirst: vi.fn(), findMany: vi.fn() },
          bundles: { findFirst: vi.fn(), findMany: vi.fn() },
        },
        update: vi.fn(),
      },
      provider: "sqlite",
    });

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
    it("includes relations, defaults, and indexes in Prisma output", () => {
      const code = generateSchema(prismaSchemaHotUpdater, "latest").code;

      expect(code).toContain('metadata Json @default("{}")');
      expect(code).toContain('value String @default("1.0.1")');
      expect(code).toContain("model channels {");
      expect(code).toContain("id String @db.VarChar(255) @id");
      expect(code).toContain("name String @db.VarChar(255)");
      expect(code).toContain('@@unique([name], map: "channels_name_key")');
      expect(code).toContain("channel_id String @db.VarChar(255)");
      expect(code).toContain(
        'channelRecord channels @relation("releases_channels", fields: [channel_id], references: [id], onUpdate: Restrict, onDelete: Restrict)',
      );
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
      expect(code).not.toContain(
        '@@index([channel], map: "bundles_channel_idx")',
      );
      expect(code).toContain(
        '@@index([scope_key, id], map: "releases_scope_order_idx")',
      );
      expect(code).toContain("scope_key String @db.VarChar(2048) @id");
      expect(code).not.toContain("bundles_platform_idx");
      expect(code).toContain(
        '@@index([bundle_id], map: "bundle_patches_bundle_id_idx")',
      );
    });

    it("omits the metadata JSON default for SQLite Prisma output", () => {
      const code = generateSchema(sqlitePrismaSchemaHotUpdater, "latest").code;

      expect(code).toContain("metadata Json");
      expect(code).not.toContain('metadata Json @default("{}")');
    });

    it("rejects generating a retired schema snapshot", () => {
      expect(() => generateSchema(prismaSchemaHotUpdater, "0.21.0")).toThrow(
        "Unsupported Hot Updater schema version: 0.21.0",
      );
    });

    it("includes foreign keys and indexes in Drizzle output", () => {
      const code = generateSchema(drizzleSchemaHotUpdater, "latest").code;
      const bundlesBlock = code.match(
        /export const bundles = [\s\S]*?(?=\n\nexport const bundle_patches = )/,
      )?.[0];
      const bundlePatchesBlock = code.match(
        /export const bundle_patches = [\s\S]*?(?=\n\nexport const bundle_patchesRelations = )/,
      )?.[0];

      expect(code).toContain(
        'metadata: json("metadata").notNull().default({})',
      );
      expect(code).toContain('name: "bundle_patches_bundle_id_fk"');
      expect(code).toContain('name: "bundle_patches_base_bundle_id_fk"');
      expect(code).toContain('.onDelete("cascade")');
      expect(bundlesBlock).not.toContain("bundles_channel_idx");
      expect(bundlesBlock).not.toContain("bundles_platform_idx");
      expect(bundlesBlock).not.toContain("target_app_version");
      expect(bundlesBlock).not.toContain(
        'index("bundle_patches_bundle_id_idx").on(table.bundle_id)',
      );
      expect(bundlePatchesBlock).toContain(
        'index("bundle_patches_bundle_id_idx").on(table.bundle_id)',
      );
      expect(code).toContain(
        'index("releases_scope_order_idx").on(table.scope_key, table.id)',
      );
      expect(code).toContain(
        'scope_key: varchar("scope_key", { length: 2048 }).primaryKey().notNull()',
      );
      const generatedCode = generateDrizzleSchema("postgresql");
      expect(generatedCode).toContain(
        'id: varchar("id", { length: 255 }).primaryKey().notNull()',
      );
      expect(generatedCode).toContain(
        'version: varchar("version", { length: 255 }).notNull().default("1.0.1")',
      );
      expect(generatedCode).toContain(
        'uniqueIndex("channels_name_key").on(table.name)',
      );
      expect(generatedCode).toContain('name: "releases_channel_id_fk"');
      expect(generatedCode).toContain(
        'index("releases_channel_platform_order_idx").on(table.channel_id, table.platform, table.id)',
      );
      expect(generatedCode).not.toContain('key: varchar("key"');
      expect(generatedCode).not.toContain('value: text("value"');
    });
  });

  describe("migrator enhancements", () => {
    it("registers the original schema and additive Insights revision", () => {
      expect(hotUpdaterSchemaVersions.map((schema) => schema.version)).toEqual([
        "1.0.0",
        "1.0.1",
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

    it("adds custom indexes and constraints to generated SQL", async () => {
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
          "create index releases_scope_order_idx on releases",
        );
        expect(sql).toContain(
          "add constraint releases_strategy_target_check check",
        );
        expect(sql).toContain(
          "add constraint bundle_patches_bundle_id_fk foreign key",
        );
        expect(sql).toContain(
          "create index bundle_patches_bundle_id_idx on bundle_patches",
        );
        expect(sql).toContain("insert into private_hot_updater_settings");
        expect(result.operations).not.toContainEqual(
          expect.objectContaining({
            sql: expect.stringContaining(
              "insert into private_hot_updater_settings",
            ),
          }),
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

    it("creates MongoDB indexes for runtime query fields", async () => {
      const collection = {
        find: vi.fn(() => ({
          limit: () => ({ toArray: async () => [] }),
        })),
        listIndexes: () => ({ toArray: async () => [] }),
      };
      const client = {
        db: () => ({
          collection: () => collection,
        }),
      } as unknown as MongoClient;
      const mongoHotUpdater = createHotUpdater({
        database: mongoAdapter({ client }),
      });
      const result = await createMigrator(mongoHotUpdater).migrateToLatest({
        mode: "from-schema",
      });

      expect(result.operations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            description:
              "Create unique MongoDB index: bundles_id_idx on bundles(id)",
          }),
          expect.objectContaining({
            description:
              "Create unique MongoDB index: bundle_patches_id_idx on bundle_patches(id)",
          }),
          expect.objectContaining({
            description:
              "Create unique MongoDB index: release_catalogs_scope_key_idx on release_catalogs(scope_key)",
          }),
          expect.objectContaining({
            description:
              "Create MongoDB index: releases_fingerprint_hash_idx on releases(fingerprint_hash)",
          }),
          expect.objectContaining({
            description:
              "Create MongoDB index: bundles_platform_idx on bundles(platform)",
          }),
          expect.objectContaining({
            description:
              "Create MongoDB index: bundle_patches_base_bundle_id_idx on bundle_patches(base_bundle_id)",
          }),
        ]),
      );
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

    it("rejects runtime access when a MongoDB schema is stale", async () => {
      const settings = {
        find: vi.fn(({ key }: { readonly key: string }) => ({
          limit: () => ({
            toArray: async () =>
              key === "version" ? [{ key, value: "0.21.0" }] : [],
          }),
        })),
      };
      const bundles = {
        countDocuments: vi.fn(async () => 0),
        find: vi.fn(),
        findOne: vi.fn(),
      };
      const patches = {
        find: vi.fn(),
      };
      const client = {
        db: () => ({
          collection: (name: string) => {
            if (name === "private_hot_updater_settings") return settings;
            if (name === "bundle_patches") return patches;
            return bundles;
          },
        }),
      } as unknown as MongoClient;
      const mongoHotUpdater = createHotUpdater({
        database: mongoAdapter({ client }),
      });

      await expect(mongoHotUpdater.getBundles({ limit: 10 })).rejects.toThrow(
        "Hot Updater v1 cannot migrate schema 0.21.0 in place.",
      );
      expect(bundles.countDocuments).not.toHaveBeenCalled();
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

    it("commits Prisma bundle changes inside a transaction when available", async () => {
      const rootBundles = {
        count: vi.fn(),
        create: vi.fn(),
        deleteMany: vi.fn(),
        findFirst: vi.fn(),
        findMany: vi.fn(),
        update: vi.fn(),
        upsert: vi.fn(),
      };
      const rootPatches = {
        count: vi.fn(),
        create: vi.fn(),
        deleteMany: vi.fn(),
        findFirst: vi.fn(),
        findMany: vi.fn(),
        update: vi.fn(),
        upsert: vi.fn(),
      };
      const channels = {
        count: vi.fn(),
        create: vi.fn(),
        deleteMany: vi.fn(),
        findFirst: vi.fn(async () => ({
          id: transactionChannelId,
          name: "production",
        })),
        findMany: vi.fn(),
        update: vi.fn(),
        upsert: vi.fn(),
      };
      const txBundles = {
        ...rootBundles,
        create: vi.fn(async ({ data }) => data),
      };
      const txPatches = { ...rootPatches };
      const $transaction = vi.fn(
        async (operation: (tx: Record<string, unknown>) => Promise<unknown>) =>
          operation({
            bundle_patches: txPatches,
            bundles: txBundles,
            channels,
          }),
      );
      const adapter = prismaAdapter({
        prisma: {
          $transaction,
          bundle_patches: rootPatches,
          bundles: rootBundles,
          channels,
        },
        provider: "postgresql",
      });

      await adapter.commit({
        changes: [
          {
            model: "bundles",
            operation: "insert",
            row: bundleToRow(transactionBundle),
          },
        ],
      });

      expect($transaction).toHaveBeenCalledTimes(1);
      expect(txBundles.create).toHaveBeenCalledTimes(1);
      expect(rootBundles.create).not.toHaveBeenCalled();
    });

    it("commits Drizzle bundle changes inside a transaction when available", async () => {
      const tables = {
        bundle_events: {
          id: "event_id",
        },
        bundle_installations: {
          install_id: "install_id",
        },
        bundle_patches: {
          bundle_id: "bundle_id",
          id: "patch_id",
          order_index: "order_index",
        },
        bundles: {
          id: "id",
        },
        channels: {
          id: sql.raw("channel_id"),
          name: sql.raw("channel_name"),
        },
        api_keys: {
          id: "access_key_id",
        },
        release_catalogs: {
          scope_key: "scope_key",
        },
        releases: {
          id: "release_id",
          scope_key: "scope_key",
        },
      };
      const rootInsert = vi.fn(() => ({
        values: vi.fn(() => ({ execute: vi.fn(async () => undefined) })),
      }));
      const txInsert = vi.fn(() => ({
        values: vi.fn(() => ({ execute: vi.fn(async () => undefined) })),
      }));
      const createDb = (insert: typeof rootInsert) => ({
        _: { fullSchema: tables },
        $count: vi.fn(),
        delete: vi.fn(() => ({
          where: vi.fn(async () => undefined),
        })),
        insert,
        query: {
          bundle_events: {
            findFirst: vi.fn(),
            findMany: vi.fn(),
          },
          bundle_installations: {
            findFirst: vi.fn(),
            findMany: vi.fn(),
          },
          bundle_patches: {
            findFirst: vi.fn(),
            findMany: vi.fn(),
          },
          bundles: {
            findFirst: vi.fn(async () => undefined),
            findMany: vi.fn(),
          },
          channels: {
            findFirst: vi.fn(async () => ({
              id: transactionChannelId,
              name: "production",
            })),
            findMany: vi.fn(),
          },
          api_keys: {
            findFirst: vi.fn(),
            findMany: vi.fn(),
          },
          release_catalogs: {
            findFirst: vi.fn(),
            findMany: vi.fn(),
          },
          releases: {
            findFirst: vi.fn(),
            findMany: vi.fn(),
          },
        },
        select: vi.fn(),
        update: vi.fn(() => ({
          set: vi.fn(() => ({
            where: vi.fn(async () => undefined),
          })),
        })),
      });
      const txDb = createDb(txInsert);
      const transaction = vi.fn(
        async (operation: (tx: typeof txDb) => Promise<unknown>) =>
          operation(txDb),
      );
      const db = {
        ...createDb(rootInsert),
        transaction,
      };
      const adapter = drizzleAdapter({
        db,
        provider: "postgresql",
      });

      await adapter.commit({
        changes: [
          {
            model: "bundles",
            operation: "insert",
            row: bundleToRow(transactionBundle),
          },
        ],
      });

      expect(transaction).toHaveBeenCalledTimes(1);
      expect(txInsert).toHaveBeenCalledTimes(1);
      expect(rootInsert).not.toHaveBeenCalled();
    });

    it("does not expose an implicit MongoDB transaction", () => {
      const bundles = {
        countDocuments: vi.fn(),
        deleteMany: vi.fn(),
        distinct: vi.fn(),
        find: vi.fn(),
        findOne: vi.fn(),
        updateOne: vi.fn(async () => undefined),
      };
      const patches = {
        deleteMany: vi.fn(async () => undefined),
        find: vi.fn(),
        insertMany: vi.fn(),
      };
      const client = {
        db: () => ({
          collection: (name: string) =>
            name === "bundle_patches" ? patches : bundles,
        }),
      } as unknown as MongoClient;
      const adapter = mongoAdapter({ client });

      expect(Reflect.has(adapter, "transaction")).toBe(false);
    });

    it("uses a MongoDB session when transactions are enabled", async () => {
      const client = new MongoClient("mongodb://localhost");
      const session = client.startSession();
      const withTransaction = vi.fn(
        async (operation: (session: ClientSession) => Promise<unknown>) =>
          operation(session),
      );
      Object.defineProperty(session, "withTransaction", {
        value: withTransaction,
      });
      const insertOne = vi.fn(async () => undefined);
      Object.defineProperty(client, "db", {
        value: () => ({
          collection: () => ({
            findOne: vi.fn(async () => ({
              id: transactionChannelId,
              name: "production",
            })),
            insertOne,
            updateOne: vi.fn(async () => ({ matchedCount: 1 })),
          }),
        }),
      });
      const withSession = vi.fn(
        async (operation: (session: ClientSession) => Promise<unknown>) =>
          operation(session),
      );
      Object.defineProperty(client, "withSession", { value: withSession });
      const adapter = mongoAdapter({ client, transactions: true });

      await adapter.commit({
        changes: [
          {
            model: "bundles",
            operation: "insert",
            row: bundleToRow(transactionBundle),
          },
        ],
      });

      expect(withSession).toHaveBeenCalledTimes(1);
      expect(withTransaction).toHaveBeenCalledTimes(1);
      expect(insertOne).toHaveBeenCalledWith(bundleToRow(transactionBundle), {
        session,
      });
    });
  });

  describe("getBundleById", () => {
    it("should retrieve bundle by id without Prisma validation errors", async () => {
      const bundle: Bundle = {
        archiveByteSize: 1_024,
        id: "00000000-0000-0000-0000-000000000010",
        platform: "ios",
        fileHash: "test-hash",
        gitCommitHash: null,
        storageUri: "s3://test-bucket/test.zip",
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

    it("resolves s3:// storage URI to signed URL via s3StoragePlugin", async () => {
      const bundle: Bundle = {
        archiveByteSize: 1_024,
        id: "00000000-0000-0000-0000-000000000001",
        platform: "ios",
        fileHash: "hash123",
        gitCommitHash: null,
        storageUri: "s3://test-bucket/bundles/bundle.zip",
      };

      await hotUpdater.insertBundle(bundle);

      const updateInfo = await hotUpdater.getArtifactInfo(bundle.id, NIL_UUID);

      expect(updateInfo).not.toBeNull();
      expect(updateInfo?.fileUrl).toBe(
        "https://s3.example.com/test-bucket/bundles/bundle.zip",
      );
    });

    it("returns manifest metadata and hbc patch descriptors", async () => {
      const currentManifestStorageUri =
        "s3://test-bucket/releases/bundles/00000000-0000-0000-0000-000000000101/manifest.json";
      const nextManifestStorageUri =
        "s3://test-bucket/releases/bundles/00000000-0000-0000-0000-000000000102/manifest.json";
      const olderBundle: Bundle = {
        archiveByteSize: 1_024,
        id: "00000000-0000-0000-0000-000000000100",
        platform: "ios",
        fileHash: "hash-older-zip",
        gitCommitHash: null,
        storageUri:
          "s3://test-bucket/releases/bundles/00000000-0000-0000-0000-000000000100/bundle.zip",
      };
      const currentBundle: Bundle = {
        archiveByteSize: 1_024,
        id: "00000000-0000-0000-0000-000000000101",
        platform: "ios",
        fileHash: "hash-current-zip",
        gitCommitHash: null,
        storageUri:
          "s3://test-bucket/releases/bundles/00000000-0000-0000-0000-000000000101/bundle.zip",
        assetBaseStorageUri: "s3://test-bucket/releases/assets",
        manifestFileHash: "sig:manifest-current",
        manifestStorageUri: currentManifestStorageUri,
      };
      const nextBundle: Bundle = {
        archiveByteSize: 1_024,
        id: "00000000-0000-0000-0000-000000000102",
        platform: "ios",
        fileHash: "hash-next-zip",
        gitCommitHash: null,
        storageUri:
          "s3://test-bucket/releases/bundles/00000000-0000-0000-0000-000000000102/bundle.zip",
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
          hotUpdater.getArtifactInfo(nextBundle.id, currentBundle.id),
        ).resolves.toEqual({
          changedAssets: {
            "index.ios.bundle": {
              file: {
                compression: "br",
                url: "https://s3.example.com/test-bucket/releases/assets/sha256/ha/hash-new-bundle.br",
              },
              fileHash: "hash-new-bundle",
              patch: {
                algorithm: "bsdiff",
                baseBundleId: currentBundle.id,
                baseFileHash: "hash-old-bundle",
                patchFileHash: "hash-bsdiff",
                patchUrl:
                  "https://s3.example.com/test-bucket/releases/bundles/00000000-0000-0000-0000-000000000102/patches/00000000-0000-0000-0000-000000000101/index.ios.bundle.bsdiff",
              },
            },
          },
          fileHash: "hash-next-zip",
          fileUrl:
            "https://s3.example.com/test-bucket/releases/bundles/00000000-0000-0000-0000-000000000102/bundle.zip",
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
        archiveByteSize: 1_024,
        id: "00000000-0000-0000-0000-000000000109",
        platform: "ios",
        fileHash: "hash-next-zip",
        gitCommitHash: null,
        storageUri:
          "s3://test-bucket/releases/bundles/00000000-0000-0000-0000-000000000109/bundle.zip",
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
        hotUpdater.getArtifactInfo(nextBundle.id, NIL_UUID),
      ).rejects.toThrow("storage read failed");
    });
  });
});
