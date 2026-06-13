import { enhanceGeneratedSchema } from "./schemaEnhancements";
import type { ORMProvider, ORMSQLProvider } from "./types";

const prismaDb = (type: string, provider: ORMProvider) => {
  if (provider === "postgresql") {
    if (type === "uuid") return " @db.Uuid";
    if (type === "varchar") return " @db.VarChar(255)";
  }
  if (provider === "mysql") {
    if (type === "uuid") return " @db.Char(36)";
    if (type === "varchar") return " @db.VarChar(255)";
  }
  return "";
};

export const generatePrismaSchema = (provider: ORMProvider) => {
  const uuid = prismaDb("uuid", provider);
  const varchar = prismaDb("varchar", provider);
  const metadataDefault =
    provider === "sqlite" ? "metadata Json" : 'metadata Json @default("{}")';
  return enhanceGeneratedSchema(
    "prisma",
    `model bundles {
  id String${uuid} @id
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
  ${metadataDefault}
  manifest_storage_uri String?
  manifest_file_hash String?
  asset_base_storage_uri String?
  rollout_cohort_count Int @default(1000)
  target_cohorts Json?
}
model bundle_patches {
  id String${varchar} @id
  bundle_id String${uuid}
  base_bundle_id String${uuid}
  base_file_hash String
  patch_file_hash String
  patch_storage_uri String
  order_index Int @default(0)
  bundle bundles @relation("bundle_patches_bundles_patches", fields: [bundle_id], references: [id], onUpdate: Restrict, onDelete: Cascade)
  baseBundle bundles @relation("bundle_patches_bundles_baseForPatches", fields: [base_bundle_id], references: [id], onUpdate: Restrict, onDelete: Cascade)
}
model private_hot_updater_settings {
  key String${varchar} @id
  value String @default("0.31.0")
}`,
    provider,
  );
};

const drizzleImportSource = (provider: ORMSQLProvider) =>
  provider === "sqlite"
    ? "drizzle-orm/sqlite-core"
    : provider === "mysql"
      ? "drizzle-orm/mysql-core"
      : "drizzle-orm/pg-core";

const drizzleTableFn = (provider: ORMSQLProvider) =>
  provider === "sqlite"
    ? "sqliteTable"
    : provider === "mysql"
      ? "mysqlTable"
      : "pgTable";

const drizzleTypes = (provider: ORMSQLProvider) => {
  if (provider === "sqlite") {
    return {
      id: 'text("id")',
      uuid: "text",
      bool: 'integer("should_force_update", { mode: "boolean" })',
      enabled: 'integer("enabled", { mode: "boolean" })',
      json: 'blob("metadata", { mode: "json" })',
      cohorts: 'blob("target_cohorts", { mode: "json" })',
      varchar: 'text("id", { length: 255 })',
      imports: "sqliteTable, text, integer, blob, foreignKey, index",
    };
  }
  if (provider === "mysql") {
    return {
      id: 'char("id", { length: 36 })',
      uuid: "char",
      bool: 'boolean("should_force_update")',
      enabled: 'boolean("enabled")',
      json: 'json("metadata")',
      cohorts: 'json("target_cohorts")',
      varchar: 'varchar("id", { length: 255 })',
      imports:
        "mysqlTable, char, text, boolean, json, int, varchar, foreignKey, index",
    };
  }
  return {
    id: 'uuid("id")',
    uuid: "uuid",
    bool: 'boolean("should_force_update")',
    enabled: 'boolean("enabled")',
    json: 'json("metadata")',
    cohorts: 'json("target_cohorts")',
    varchar: 'varchar("id", { length: 255 })',
    imports:
      "pgTable, uuid, text, boolean, json, integer, varchar, foreignKey, index",
  };
};

export const generateDrizzleSchema = (provider: ORMSQLProvider) => {
  const tableFn = drizzleTableFn(provider);
  const types = drizzleTypes(provider);
  const int = provider === "mysql" ? "int" : "integer";
  const settingsVersion =
    provider === "sqlite"
      ? 'text("version", { length: 255 })'
      : 'varchar("version", { length: 255 })';
  return `import { ${types.imports} } from "${drizzleImportSource(provider)}"
import { relations } from "drizzle-orm"

export const bundles = ${tableFn}("bundles", {
  id: ${types.id}.primaryKey().notNull(),
  platform: text("platform").notNull(),
  should_force_update: ${types.bool}.notNull(),
  enabled: ${types.enabled}.notNull(),
  file_hash: text("file_hash").notNull(),
  git_commit_hash: text("git_commit_hash"),
  message: text("message"),
  channel: text("channel").notNull().default("production"),
  storage_uri: text("storage_uri").notNull(),
  target_app_version: text("target_app_version"),
  fingerprint_hash: text("fingerprint_hash"),
  metadata: ${types.json}.notNull().default({}),
  manifest_storage_uri: text("manifest_storage_uri"),
  manifest_file_hash: text("manifest_file_hash"),
  asset_base_storage_uri: text("asset_base_storage_uri"),
  rollout_cohort_count: ${int}("rollout_cohort_count").notNull().default(1000),
  target_cohorts: ${types.cohorts}
}, (table) => [
  index("bundles_target_app_version_idx").on(table.target_app_version),
  index("bundles_fingerprint_hash_idx").on(table.fingerprint_hash),
  index("bundles_channel_idx").on(table.channel),
  index("bundles_rollout_idx").on(table.rollout_cohort_count),
])

export const bundle_patches = ${tableFn}("bundle_patches", {
  id: ${types.varchar}.primaryKey().notNull(),
  bundle_id: ${types.uuid}("bundle_id").notNull(),
  base_bundle_id: ${types.uuid}("base_bundle_id").notNull(),
  base_file_hash: text("base_file_hash").notNull(),
  patch_file_hash: text("patch_file_hash").notNull(),
  patch_storage_uri: text("patch_storage_uri").notNull(),
  order_index: ${int}("order_index").notNull().default(0)
}, (table) => [
  foreignKey({
    columns: [table.bundle_id],
    foreignColumns: [bundles.id],
    name: "bundle_patches_bundle_id_fk"
  }).onUpdate("restrict").onDelete("cascade"),
  foreignKey({
    columns: [table.base_bundle_id],
    foreignColumns: [bundles.id],
    name: "bundle_patches_base_bundle_id_fk"
  }).onUpdate("restrict").onDelete("cascade"),
  index("bundle_patches_bundle_id_idx").on(table.bundle_id),
  index("bundle_patches_base_bundle_id_idx").on(table.base_bundle_id),
])

export const bundle_patchesRelations = relations(bundle_patches, ({ one }) => ({
  bundle: one(bundles, {
    relationName: "bundle_patches_bundles_patches",
    fields: [bundle_patches.bundle_id],
    references: [bundles.id]
  }),
  baseBundle: one(bundles, {
    relationName: "bundle_patches_bundles_baseForPatches",
    fields: [bundle_patches.base_bundle_id],
    references: [bundles.id]
  })
}));

export const private_hot_updater_settings = ${tableFn}("${"private_hot_updater_settings"}", {
  id: ${types.varchar}.primaryKey().notNull(),
  version: ${settingsVersion}.notNull().default("0.31.0")
})`;
};
