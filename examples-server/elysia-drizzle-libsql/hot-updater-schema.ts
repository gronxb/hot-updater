import { sqliteTable, text, integer, blob } from "drizzle-orm/sqlite-core"

export const bundles = sqliteTable("bundles", {
  id: text("id").primaryKey().notNull(),
  platform: text("platform").notNull(),
  should_force_update: integer("should_force_update", { mode: "boolean" }).notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull(),
  file_hash: text("file_hash").notNull(),
  git_commit_hash: text("git_commit_hash"),
  message: text("message"),
  channel: text("channel").notNull(),
  storage_uri: text("storage_uri").notNull(),
  target_app_version: text("target_app_version"),
  fingerprint_hash: text("fingerprint_hash"),
  metadata: blob("metadata", { mode: "json" }).notNull(),
  manifest_storage_uri: text("manifest_storage_uri"),
  manifest_file_hash: text("manifest_file_hash"),
  asset_base_storage_uri: text("asset_base_storage_uri"),
  patch_base_bundle_id: text("patch_base_bundle_id"),
  patch_base_file_hash: text("patch_base_file_hash"),
  patch_file_hash: text("patch_file_hash"),
  patch_storage_uri: text("patch_storage_uri"),
  rollout_cohort_count: integer("rollout_cohort_count").notNull().default(1000),
  target_cohorts: blob("target_cohorts", { mode: "json" })
})

export const private_hot_updater_settings = sqliteTable("private_hot_updater_settings", {
  id: text("id", { length: 255 }).primaryKey().notNull(),
  version: text("version", { length: 255 }).notNull().default("0.31.0")
})