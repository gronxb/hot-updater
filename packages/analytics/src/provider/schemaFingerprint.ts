import {
  ANALYTICS_SCHEMA_FINGERPRINT_V1,
  ANALYTICS_SCHEMA_FINGERPRINT_V2,
} from "./migration.js";

export type AnalyticsPhysicalColumn = {
  readonly name: string;
  readonly nullable: boolean;
  readonly type: "id" | "number" | "string";
};

export type AnalyticsPhysicalIndex = {
  readonly columns: readonly string[];
  readonly name: string;
  readonly unique: boolean;
};

export type AnalyticsPhysicalSchema = {
  readonly checks: readonly string[];
  readonly columns: readonly AnalyticsPhysicalColumn[];
  readonly indexes: readonly AnalyticsPhysicalIndex[];
};

const baseColumns = [
  { name: "id", nullable: false, type: "id" },
  { name: "type", nullable: false, type: "string" },
  { name: "install_id", nullable: false, type: "string" },
  { name: "user_id", nullable: true, type: "string" },
  { name: "username", nullable: true, type: "string" },
] as const;

const columnsBeforeUpdateStrategy = [
  { name: "to_bundle_id", nullable: false, type: "id" },
  { name: "platform", nullable: false, type: "string" },
  { name: "app_version", nullable: false, type: "string" },
  { name: "channel", nullable: false, type: "string" },
  { name: "cohort", nullable: false, type: "string" },
] as const;

const columnsAfterUpdateStrategy = [
  { name: "fingerprint_hash", nullable: true, type: "string" },
  { name: "sdk_version", nullable: true, type: "string" },
  { name: "received_at_ms", nullable: false, type: "number" },
] as const;

const indexes = [
  {
    name: "bundle_events_installed_bundle_idx",
    columns: ["type", "to_bundle_id", "received_at_ms", "id"],
    unique: false,
  },
  {
    name: "bundle_events_recovered_bundle_idx",
    columns: ["type", "from_bundle_id", "received_at_ms", "id"],
    unique: false,
  },
  {
    name: "bundle_events_install_idx",
    columns: ["install_id", "received_at_ms", "id"],
    unique: false,
  },
  {
    name: "bundle_events_user_id_idx",
    columns: ["user_id", "received_at_ms", "id"],
    unique: false,
  },
  {
    name: "bundle_events_username_idx",
    columns: ["username", "received_at_ms", "id"],
    unique: false,
  },
  {
    name: "bundle_events_cohort_idx",
    columns: ["cohort", "type", "received_at_ms", "id"],
    unique: false,
  },
  {
    name: "bundle_events_received_at_idx",
    columns: ["received_at_ms", "id"],
    unique: false,
  },
] as const;

export const ANALYTICS_PHYSICAL_SCHEMA_V1: AnalyticsPhysicalSchema = {
  checks: ["type-transition-only", "update-strategy-required"],
  columns: [
    ...baseColumns,
    { name: "from_bundle_id", nullable: false, type: "id" },
    ...columnsBeforeUpdateStrategy,
    { name: "update_strategy", nullable: false, type: "string" },
    ...columnsAfterUpdateStrategy,
  ],
  indexes,
};

export const ANALYTICS_PHYSICAL_SCHEMA_V2: AnalyticsPhysicalSchema = {
  checks: ["event-shape-v2", "type-with-unchanged", "update-strategy-optional"],
  columns: [
    ...baseColumns,
    { name: "from_bundle_id", nullable: true, type: "id" },
    ...columnsBeforeUpdateStrategy,
    { name: "update_strategy", nullable: true, type: "string" },
    ...columnsAfterUpdateStrategy,
  ],
  indexes,
};

function hasSameSerializedShape(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function fingerprintAnalyticsPhysicalSchema(
  schema: AnalyticsPhysicalSchema | null,
): string | null {
  if (schema === null) {
    return null;
  }
  if (hasSameSerializedShape(schema, ANALYTICS_PHYSICAL_SCHEMA_V1)) {
    return ANALYTICS_SCHEMA_FINGERPRINT_V1;
  }
  if (hasSameSerializedShape(schema, ANALYTICS_PHYSICAL_SCHEMA_V2)) {
    return ANALYTICS_SCHEMA_FINGERPRINT_V2;
  }
  return "analytics-schema-drift";
}
