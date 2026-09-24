import { defineAggregate, defineTable } from "../database/schema";

/** Core's schema version: the `schema.core` settings row. */
export const HOT_UPDATER_SCHEMA_VERSION = "1.0.0";

const bundles = defineTable(
  {
    id: { type: "string", maxLength: 36 },
    platform: { type: "string", maxLength: 16 },
    git_commit_hash: { type: "string", maxLength: 255, required: false },
    metadata: { type: "json" },
    manifest_storage_uri: { type: "string" },
    manifest_file_hash: { type: "string" },
    asset_base_storage_uri: { type: "string" },
  },
  {
    key: ["id"],
    indexes: {
      byPlatform: { eq: ["platform"], sort: ["id"] },
      all: { eq: [], sort: ["id"] },
    },
  },
);

const bundlePatches = defineTable(
  {
    id: { type: "string", maxLength: 255 },
    bundle_id: {
      type: "string",
      maxLength: 36,
      references: { model: "bundles", onDelete: "cascade" },
    },
    base_bundle_id: {
      type: "string",
      maxLength: 36,
      references: { model: "bundles", onDelete: "cascade" },
    },
    base_file_hash: { type: "string" },
    patch_file_hash: { type: "string" },
    patch_storage_uri: { type: "string" },
    byte_size: { type: "integer" },
    order_index: { type: "integer" },
  },
  {
    key: ["id"],
    indexes: {
      pair: { eq: ["bundle_id", "base_bundle_id"], sort: [], unique: true },
      byBundle: {
        eq: ["bundle_id"],
        sort: ["order_index"],
        root: { model: "bundles" },
      },
      byBase: { eq: ["base_bundle_id"], sort: ["bundle_id"] },
    },
  },
);

const releases = defineTable(
  {
    id: { type: "string", maxLength: 36 },
    revision: { type: "integer" },
    scope_key: { type: "string", maxLength: 2048, ascii: true },
    channel_id: {
      type: "string",
      maxLength: 255,
      references: { model: "channels", onDelete: "restrict" },
    },
    platform: { type: "string", maxLength: 16 },
    kind: { type: "string", maxLength: 16 },
    bundle_id: {
      type: "string",
      maxLength: 36,
      required: false,
      references: { model: "bundles", onDelete: "restrict" },
    },
    strategy: { type: "string", maxLength: 16 },
    target_app_version: { type: "string", required: false },
    fingerprint_hash: { type: "string", maxLength: 255, required: false },
    enabled: { type: "boolean" },
    should_force_update: { type: "boolean" },
    message: { type: "string", required: false },
    rollout_cohort_count: { type: "integer" },
    target_cohorts: { type: "json" },
    operation: { type: "string", maxLength: 16 },
    source_release_id: {
      type: "string",
      maxLength: 36,
      required: false,
      references: { model: "releases", onDelete: "none" },
    },
    created_at_ms: { type: "integer" },
    updated_at_ms: { type: "integer" },
  },
  {
    key: ["id"],
    indexes: {
      byScope: {
        eq: ["scope_key"],
        sort: ["id"],
        root: { model: "release_catalogs" },
      },
      byScopeEnabled: {
        eq: ["scope_key", "enabled"],
        sort: ["id"],
        root: { model: "release_catalogs" },
      },
      byChannelPlatform: { eq: ["channel_id", "platform"], sort: ["id"] },
      byChannelPlatformEnabled: {
        eq: ["channel_id", "platform", "enabled"],
        sort: ["id"],
      },
      byBundle: { eq: ["bundle_id"], sort: ["id"] },
      all: { eq: [], sort: ["id"] },
    },
  },
);

/** One compiled catalog per scope; the update check reads exactly this row. */
const releaseCatalogs = defineTable(
  {
    scope_key: { type: "string", maxLength: 2048, ascii: true },
    catalog_id: { type: "string", maxLength: 255 },
    strategy: { type: "string", maxLength: 16 },
    channel_id: {
      type: "string",
      maxLength: 255,
      references: { model: "channels", onDelete: "none" },
    },
    channel_key: { type: "string", maxLength: 1400, ascii: true },
    platform: { type: "string", maxLength: 16 },
    fingerprint_hash: { type: "string", maxLength: 255, required: false },
    generation: { type: "integer" },
    payload: { type: "string" },
    catalog_hash: { type: "string", maxLength: 71 },
    byte_size: { type: "integer" },
    is_tombstone: { type: "boolean" },
    updated_at_ms: { type: "integer" },
  },
  { key: ["scope_key"], indexes: { all: { eq: [], sort: ["scope_key"] } } },
);

const channels = defineTable(
  {
    id: { type: "string", maxLength: 255 },
    name: { type: "string", maxLength: 255, unique: true },
  },
  { key: ["id"], indexes: { all: { eq: [], sort: ["name"] } } },
);

/** Bundles per platform and in total (`platform_key` is a platform or `*`). */
const bundleTotals = defineAggregate(
  { platform_key: { type: "string", maxLength: 16 } },
  {
    key: ["platform_key"],
    counters: ["bundles"],
    indexes: { byPlatform: { eq: ["platform_key"], sort: [] } },
  },
);

/** Enabled bundle releases per patch-compatibility key, for auto-patch base search. */
const baseCandidates = defineAggregate(
  {
    candidate_key: { type: "string", maxLength: 2048, ascii: true },
    bundle_id: { type: "string", maxLength: 36 },
  },
  {
    key: ["candidate_key", "bundle_id"],
    gauges: ["releases"],
    indexes: { byKey: { eq: ["candidate_key"], sort: ["bundle_id"] } },
  },
);

export const coreSchema = {
  bundles,
  bundle_patches: bundlePatches,
  releases,
  release_catalogs: releaseCatalogs,
  channels,
  bundle_totals: bundleTotals,
  base_candidates: baseCandidates,
} as const;

export type CoreSchema = typeof coreSchema;

/** Core's module: always installed, never a plugin. */
export const coreModule = { id: "core", schema: coreSchema } as const;
