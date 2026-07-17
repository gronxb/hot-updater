import { boolean, doublePrecision, foreignKey, index, integer, json, pgTable, text, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core"

import { relations } from "drizzle-orm"

export const channels = pgTable("channels", {
  id: varchar("id", { length: 255 }).primaryKey().notNull(),
  name: varchar("name", { length: 255 }).notNull()
}, (table) => [
  uniqueIndex("channels_name_key").on(table.name)
])

export const channelsRelations = relations(channels, ({ many }) => ({
  bundles: many(bundles, {
    relationName: "channels_bundles_channel"
  })
}))

export const bundles = pgTable("bundles", {
  id: uuid("id").primaryKey().notNull(),
  platform: text("platform").notNull(),
  should_force_update: boolean("should_force_update").notNull(),
  enabled: boolean("enabled").notNull(),
  file_hash: text("file_hash").notNull(),
  git_commit_hash: text("git_commit_hash"),
  message: text("message"),
  channel: text("channel").notNull().default("production"),
  channel_id: varchar("channel_id", { length: 255 }).notNull(),
  storage_uri: text("storage_uri").notNull(),
  target_app_version: text("target_app_version"),
  fingerprint_hash: text("fingerprint_hash"),
  metadata: json("metadata").notNull().default({}),
  rollout_cohort_count: integer("rollout_cohort_count").notNull().default(1000),
  target_cohorts: json("target_cohorts"),
  manifest_storage_uri: text("manifest_storage_uri"),
  manifest_file_hash: text("manifest_file_hash"),
  asset_base_storage_uri: text("asset_base_storage_uri")
}, (table) => [
  foreignKey({
    columns: [table.channel_id],
    foreignColumns: [channels.id],
    name: "bundles_channel_id_fk"
  }).onUpdate("restrict").onDelete("restrict"),
  index("bundles_target_app_version_idx").on(table.target_app_version),
  index("bundles_fingerprint_hash_idx").on(table.fingerprint_hash),
  index("bundles_channel_idx").on(table.channel),
  index("bundles_channel_id_idx").on(table.channel_id),
  index("bundles_rollout_idx").on(table.rollout_cohort_count)
])

export const bundlesRelations = relations(bundles, ({ one, many }) => ({
  channelRef: one(channels, {
    relationName: "channels_bundles_channel",
    fields: [bundles.channel_id],
    references: [channels.id]
  }),
  patches: many(bundle_patches, {
    relationName: "bundle_patches_bundles_patches"
  }),
  baseForPatches: many(bundle_patches, {
    relationName: "bundle_patches_bundles_baseForPatches"
  })
}))

export const bundle_patches = pgTable("bundle_patches", {
  id: varchar("id", { length: 255 }).primaryKey().notNull(),
  bundle_id: uuid("bundle_id").notNull(),
  base_bundle_id: uuid("base_bundle_id").notNull(),
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

export const bundle_events = pgTable("bundle_events", {
  id: uuid("id").primaryKey().notNull(),
  type: text("type").notNull(),
  install_id: text("install_id").notNull(),
  user_id: text("user_id"),
  username: text("username"),
  from_bundle_id: uuid("from_bundle_id"),
  to_bundle_id: uuid("to_bundle_id").notNull(),
  platform: text("platform").notNull(),
  app_version: text("app_version").notNull(),
  channel: text("channel").notNull(),
  cohort: text("cohort").notNull(),
  update_strategy: text("update_strategy"),
  fingerprint_hash: text("fingerprint_hash"),
  sdk_version: text("sdk_version"),
  received_at_ms: doublePrecision("received_at_ms").notNull()
}, (table) => [
  index("bundle_events_installed_bundle_idx").on(table.type, table.to_bundle_id, table.received_at_ms, table.id),
  index("bundle_events_recovered_bundle_idx").on(table.type, table.from_bundle_id, table.received_at_ms, table.id),
  index("bundle_events_install_idx").on(table.install_id, table.received_at_ms, table.id),
  index("bundle_events_user_id_idx").on(table.user_id, table.received_at_ms, table.id),
  index("bundle_events_username_idx").on(table.username, table.received_at_ms, table.id),
  index("bundle_events_cohort_idx").on(table.cohort, table.type, table.received_at_ms, table.id),
  index("bundle_events_received_at_idx").on(table.received_at_ms, table.id)
])

export const private_hot_updater_settings = pgTable("private_hot_updater_settings", {
  id: varchar("id", { length: 255 }).primaryKey().notNull(),
  version: varchar("version", { length: 255 }).notNull().default("0.38.0")
})