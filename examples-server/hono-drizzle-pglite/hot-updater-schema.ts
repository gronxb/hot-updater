import {
  boolean,
  integer,
  json,
  pgTable,
  text,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

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
  rollout_percentage: integer("rollout_percentage").notNull().default(100),
  target_device_ids: json("target_device_ids"),
});

export const device_events = pgTable("device_events", {
  id: uuid("id").primaryKey().notNull(),
  device_id: text("device_id").notNull(),
  bundle_id: uuid("bundle_id").notNull(),
  event_type: text("event_type").notNull(),
  platform: text("platform").notNull(),
  app_version: text("app_version"),
  channel: text("channel").notNull(),
  metadata: json("metadata").notNull(),
});

export const private_hot_updater_settings = pgTable(
  "private_hot_updater_settings",
  {
    id: varchar("id", { length: 255 }).primaryKey().notNull(),
    version: varchar("version", { length: 255 }).notNull().default("0.26.0"),
  },
);
