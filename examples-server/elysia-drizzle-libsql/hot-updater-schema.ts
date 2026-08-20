import { blob, foreignKey, index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"

import { relations } from "drizzle-orm"

export const channels = sqliteTable("channels", {
  id: text("id", { length: 255 }).primaryKey().notNull(),
  name: text("name", { length: 255 }).notNull()
}, (table) => [
  uniqueIndex("channels_name_key").on(table.name)
])

export const channelsRelations = relations(channels, ({ many }) => ({
  releases: many(releases, {
    relationName: "releases_channels"
  }),
  releaseCatalogs: many(release_catalogs, {
    relationName: "release_catalogs_channels"
  })
}))

export const bundles = sqliteTable("bundles", {
  id: text("id").primaryKey().notNull(),
  platform: text("platform").notNull(),
  file_hash: text("file_hash").notNull(),
  git_commit_hash: text("git_commit_hash"),
  storage_uri: text("storage_uri").notNull(),
  metadata: blob("metadata", { mode: "json" }).notNull().default({}),
  manifest_storage_uri: text("manifest_storage_uri"),
  manifest_file_hash: text("manifest_file_hash"),
  asset_base_storage_uri: text("asset_base_storage_uri")
})

export const bundlesRelations = relations(bundles, ({ many }) => ({
  patches: many(bundle_patches, {
    relationName: "bundle_patches_bundles_patches"
  }),
  baseForPatches: many(bundle_patches, {
    relationName: "bundle_patches_bundles_baseForPatches"
  }),
  releases: many(releases, {
    relationName: "releases_bundles"
  })
}))

export const bundle_patches = sqliteTable("bundle_patches", {
  id: text("id", { length: 255 }).primaryKey().notNull(),
  bundle_id: text("bundle_id").notNull(),
  base_bundle_id: text("base_bundle_id").notNull(),
  base_file_hash: text("base_file_hash").notNull(),
  patch_file_hash: text("patch_file_hash").notNull(),
  patch_storage_uri: text("patch_storage_uri").notNull(),
  order_index: integer("order_index").notNull().default(0)
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
  index("bundle_patches_base_bundle_id_idx").on(table.base_bundle_id)
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
}))

export const releases = sqliteTable("releases", {
  id: text("id").primaryKey().notNull(),
  revision: integer("revision").notNull(),
  scope_key: text("scope_key", { length: 2048 }).notNull(),
  channel_id: text("channel_id", { length: 255 }).notNull(),
  platform: text("platform").notNull(),
  kind: text("kind").notNull(),
  bundle_id: text("bundle_id"),
  strategy: text("strategy").notNull(),
  target_app_version: text("target_app_version"),
  fingerprint_hash: text("fingerprint_hash"),
  enabled: integer("enabled", { mode: "boolean" }).notNull(),
  should_force_update: integer("should_force_update", { mode: "boolean" }).notNull(),
  message: text("message"),
  rollout_cohort_count: integer("rollout_cohort_count").notNull().default(1000),
  target_cohorts: blob("target_cohorts", { mode: "json" }).notNull().default([]),
  operation: text("operation").notNull(),
  source_release_id: text("source_release_id"),
  created_at_ms: real("created_at_ms").notNull(),
  updated_at_ms: real("updated_at_ms").notNull()
}, (table) => [
  foreignKey({
    columns: [table.channel_id],
    foreignColumns: [channels.id],
    name: "releases_channel_id_fk"
  }).onUpdate("restrict").onDelete("restrict"),
  foreignKey({
    columns: [table.bundle_id],
    foreignColumns: [bundles.id],
    name: "releases_bundle_id_fk"
  }).onUpdate("restrict").onDelete("restrict"),
  foreignKey({
    columns: [table.source_release_id],
    foreignColumns: [table.id],
    name: "releases_source_release_id_fk"
  }).onUpdate("restrict").onDelete("set null"),
  index("releases_scope_order_idx").on(table.scope_key, table.id),
  index("releases_channel_platform_order_idx").on(table.channel_id, table.platform, table.id),
  index("releases_bundle_id_idx").on(table.bundle_id),
  index("releases_fingerprint_hash_idx").on(table.fingerprint_hash),
  index("releases_enabled_idx").on(table.enabled)
])

export const releasesRelations = relations(releases, ({ one, many }) => ({
  channelRecord: one(channels, {
    relationName: "releases_channels",
    fields: [releases.channel_id],
    references: [channels.id]
  }),
  bundle: one(bundles, {
    relationName: "releases_bundles",
    fields: [releases.bundle_id],
    references: [bundles.id]
  }),
  sourceRelease: one(releases, {
    relationName: "releases_source_release",
    fields: [releases.source_release_id],
    references: [releases.id]
  }),
  derivedReleases: many(releases, {
    relationName: "releases_source_release"
  })
}))

export const release_catalogs = sqliteTable("release_catalogs", {
  scope_key: text("scope_key", { length: 2048 }).primaryKey().notNull(),
  authority_id: text("authority_id", { length: 255 }).notNull(),
  strategy: text("strategy").notNull(),
  channel_id: text("channel_id", { length: 255 }).notNull(),
  channel_key: text("channel_key", { length: 1400 }).notNull(),
  platform: text("platform").notNull(),
  fingerprint_hash: text("fingerprint_hash"),
  generation: real("generation").notNull(),
  payload: text("payload").notNull(),
  catalog_hash: text("catalog_hash", { length: 71 }).notNull(),
  byte_size: integer("byte_size").notNull(),
  is_tombstone: integer("is_tombstone", { mode: "boolean" }).notNull(),
  updated_at_ms: real("updated_at_ms").notNull()
}, (table) => [
  foreignKey({
    columns: [table.channel_id],
    foreignColumns: [channels.id],
    name: "release_catalogs_channel_id_fk"
  }).onUpdate("restrict").onDelete("restrict"),
  index("release_catalogs_channel_idx").on(table.channel_id),
  index("release_catalogs_authority_strategy_idx").on(table.authority_id, table.strategy)
])

export const release_catalogsRelations = relations(release_catalogs, ({ one }) => ({
  channelRecord: one(channels, {
    relationName: "release_catalogs_channels",
    fields: [release_catalogs.channel_id],
    references: [channels.id]
  })
}))

export const bundle_events = sqliteTable("bundle_events", {
  id: text("id").primaryKey().notNull(),
  type: text("type").notNull(),
  install_id: text("install_id").notNull(),
  user_id: text("user_id"),
  username: text("username"),
  from_release_id: text("from_release_id"),
  from_bundle_id: text("from_bundle_id"),
  to_release_id: text("to_release_id"),
  to_bundle_id: text("to_bundle_id").notNull(),
  platform: text("platform").notNull(),
  app_version: text("app_version").notNull(),
  channel: text("channel").notNull(),
  cohort: text("cohort").notNull(),
  update_strategy: text("update_strategy"),
  fingerprint_hash: text("fingerprint_hash"),
  sdk_version: text("sdk_version"),
  received_at_ms: real("received_at_ms").notNull()
}, (table) => [
  index("bundle_events_received_at_idx").on(table.received_at_ms, table.id),
  index("bundle_events_install_idx").on(table.install_id, table.received_at_ms, table.id),
  index("bundle_events_user_id_idx").on(table.user_id, table.received_at_ms, table.id),
  index("bundle_events_username_idx").on(table.username, table.received_at_ms, table.id),
  index("bundle_events_to_bundle_idx").on(table.type, table.to_bundle_id, table.received_at_ms, table.id),
  index("bundle_events_from_bundle_idx").on(table.type, table.from_bundle_id, table.received_at_ms, table.id),
  index("bundle_events_to_release_idx").on(table.type, table.to_release_id, table.received_at_ms, table.id),
  index("bundle_events_from_release_idx").on(table.type, table.from_release_id, table.received_at_ms, table.id)
])

export const client_access_keys = sqliteTable("client_access_keys", {
  id: text("id", { length: 255 }).primaryKey().notNull(),
  hash: text("hash").notNull(),
  name: text("name").notNull(),
  prefix: text("prefix").notNull(),
  role: text("role").notNull(),
  created_at_ms: real("created_at_ms").notNull(),
  revoked_at_ms: real("revoked_at_ms")
}, (table) => [
  uniqueIndex("client_access_keys_hash_key").on(table.hash),
  index("client_access_keys_created_at_idx").on(table.created_at_ms, table.id)
])

export const private_hot_updater_settings = sqliteTable("private_hot_updater_settings", {
  id: text("id", { length: 255 }).primaryKey().notNull(),
  version: text("version", { length: 255 }).notNull().default("1.0.0")
})