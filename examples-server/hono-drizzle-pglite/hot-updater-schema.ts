import { pgTable, uuid, text, boolean, json, integer, varchar } from "drizzle-orm/pg-core"

export const bundles = pgTable("bundles", {
  id: uuid("id").primaryKey().notNull(),
  platform: text("platform").notNull(),
  should_force_update: boolean("should_force_update").notNull(),
  enabled: boolean("enabled").notNull(),
  file_hash: text("file_hash").notNull(),
  git_commit_hash: text("git_commit_hash"),
  message: text("message"),
  channel: text("channel").notNull(),
  storage_uri: text("storage_uri").notNull(),
  target_app_version: text("target_app_version"),
  fingerprint_hash: text("fingerprint_hash"),
  metadata: json("metadata").notNull(),
  manifest_storage_uri: text("manifest_storage_uri"),
  manifest_file_hash: text("manifest_file_hash"),
  asset_base_storage_uri: text("asset_base_storage_uri"),
  rollout_cohort_count: integer("rollout_cohort_count").notNull().default(1000),
  target_cohorts: json("target_cohorts")
})

export const bundle_patches = pgTable("bundle_patches", {
  id: varchar("id", { length: 255 }).primaryKey().notNull(),
  bundle_id: uuid("bundle_id").notNull(),
  base_bundle_id: uuid("base_bundle_id").notNull(),
  base_file_hash: text("base_file_hash").notNull(),
  patch_file_hash: text("patch_file_hash").notNull(),
  patch_storage_uri: text("patch_storage_uri").notNull(),
  order_index: integer("order_index").notNull().default(0)
})

export const private_hot_updater_settings = pgTable("private_hot_updater_settings", {
  id: varchar("id", { length: 255 }).primaryKey().notNull(),
  version: varchar("version", { length: 255 }).notNull().default("0.31.0")
})