import { boolean, foreignKey, index, integer, json, pgTable, text, uuid, varchar } from "drizzle-orm/pg-core"

import { relations } from "drizzle-orm"

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
  metadata: json("metadata").notNull().default({}),
  rollout_cohort_count: integer("rollout_cohort_count").notNull().default(1000),
  target_cohorts: json("target_cohorts"),
  manifest_storage_uri: text("manifest_storage_uri"),
  manifest_file_hash: text("manifest_file_hash"),
  asset_base_storage_uri: text("asset_base_storage_uri")
}, (table) => [
  index("bundles_target_app_version_idx").on(table.target_app_version),
  index("bundles_fingerprint_hash_idx").on(table.fingerprint_hash),
  index("bundles_channel_idx").on(table.channel),
  index("bundles_rollout_idx").on(table.rollout_cohort_count)
])

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
  kind: text("kind").notNull(),
  install_id: text("install_id").notNull(),
  active_bundle_id: uuid("active_bundle_id").notNull(),
  previous_active_bundle_id: uuid("previous_active_bundle_id"),
  crashed_bundle_id: uuid("crashed_bundle_id"),
  platform: text("platform").notNull(),
  channel: text("channel").notNull(),
  app_version: text("app_version"),
  fingerprint_hash: text("fingerprint_hash"),
  cohort: text("cohort"),
  user_id: text("user_id"),
  payload: json("payload").notNull()
}, (table) => [
  index("bundle_events_install_id_idx").on(table.install_id),
  index("bundle_events_active_bundle_id_idx").on(table.active_bundle_id),
  index("bundle_events_platform_channel_idx").on(table.platform, table.channel)
])

export const private_hot_updater_settings = pgTable("private_hot_updater_settings", {
  id: varchar("id", { length: 255 }).primaryKey().notNull(),
  version: varchar("version", { length: 255 }).notNull().default("0.32.0")
})
