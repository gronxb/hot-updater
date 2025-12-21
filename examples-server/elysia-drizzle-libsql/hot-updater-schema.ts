import { blob, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const bundles = sqliteTable("bundles", {
  id: text("id").primaryKey().notNull(),
  platform: text("platform").notNull(),
  should_force_update: integer("should_force_update", {
    mode: "boolean",
  }).notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull(),
  file_hash: text("file_hash").notNull(),
  git_commit_hash: text("git_commit_hash"),
  message: text("message"),
  channel: text("channel").notNull(),
  storage_uri: text("storage_uri").notNull(),
  target_app_version: text("target_app_version"),
  fingerprint_hash: text("fingerprint_hash"),
  metadata: blob("metadata", { mode: "json" }).notNull(),
  rollout_percentage: integer("rollout_percentage").notNull().default(100),
  target_device_ids: blob("target_device_ids", { mode: "json" }),
});

export const device_events = sqliteTable("device_events", {
  id: text("id").primaryKey().notNull(),
  device_id: text("device_id").notNull(),
  bundle_id: text("bundle_id").notNull(),
  event_type: text("event_type").notNull(),
  platform: text("platform").notNull(),
  app_version: text("app_version"),
  channel: text("channel").notNull(),
  metadata: blob("metadata", { mode: "json" }).notNull(),
});

export const private_hot_updater_settings = sqliteTable(
  "private_hot_updater_settings",
  {
    id: text("id", { length: 255 }).primaryKey().notNull(),
    version: text("version", { length: 255 }).notNull().default("0.26.0"),
  },
);
