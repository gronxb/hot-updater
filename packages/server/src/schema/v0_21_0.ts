import { createSettingsTable } from "./settings";
import {
  HOT_UPDATER_SETTINGS_TABLE,
  type HotUpdaterTableSchema,
  type HotUpdaterVersionedSchema,
} from "./types";

export const bundlesV021 = {
  ormName: "bundles",
  columns: [
    { ormName: "id", type: "uuid", primaryKey: true },
    { ormName: "platform", type: "string" },
    { ormName: "should_force_update", type: "bool" },
    { ormName: "enabled", type: "bool" },
    { ormName: "file_hash", type: "string" },
    { ormName: "git_commit_hash", type: "string", nullable: true },
    { ormName: "message", type: "string", nullable: true },
    {
      ormName: "channel",
      type: "string",
      default: { type: "literal", value: "production" },
    },
    { ormName: "storage_uri", type: "string" },
    { ormName: "target_app_version", type: "string", nullable: true },
    { ormName: "fingerprint_hash", type: "string", nullable: true },
    {
      ormName: "metadata",
      type: "json",
      default: { type: "json", value: {} },
    },
  ],
  indexes: [
    { name: "bundles_target_app_version_idx", columns: ["target_app_version"] },
    { name: "bundles_fingerprint_hash_idx", columns: ["fingerprint_hash"] },
    { name: "bundles_channel_idx", columns: ["channel"] },
    {
      name: "bundles_platform_idx",
      columns: ["platform"],
      providers: ["mongodb"],
    },
  ],
  checks: [
    {
      name: "check_version_or_fingerprint",
      expression:
        "(target_app_version is not null) or (fingerprint_hash is not null)",
      sqliteInline: true,
    },
  ],
} as const satisfies HotUpdaterTableSchema;

export const v0_21_0 = {
  version: "0.21.0",
  settingsTable: HOT_UPDATER_SETTINGS_TABLE,
  tables: [bundlesV021, createSettingsTable("0.21.0")],
} as const satisfies HotUpdaterVersionedSchema;
