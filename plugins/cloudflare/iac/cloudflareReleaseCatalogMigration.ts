import {
  compileLegacyReleaseCatalogBackfill,
  createReleaseCatalogBackfillInsertSql,
  type LegacyBundlePolicyRow,
} from "@hot-updater/server";

export interface D1BundleSchemaRow {
  readonly name: string;
  readonly sql: string | null;
  readonly type: "index" | "table" | "trigger";
}

export interface D1ReleaseCatalogMigrationState {
  readonly bundleSchema: readonly D1BundleSchemaRow[];
  readonly legacyBundles: readonly LegacyBundlePolicyRow[];
}

const PREFLIGHT_START = "-- hot-updater:release-catalog-preflight-start";
const PREFLIGHT_END = "-- hot-updater:release-catalog-preflight-end";
const BACKFILL_START = "-- hot-updater:release-catalog-backfill-start";
const BACKFILL_END = "-- hot-updater:release-catalog-backfill-end";
const RESTORE_START = "-- hot-updater:restore-bundles-user-schema-start";
const RESTORE_END = "-- hot-updater:restore-bundles-user-schema-end";

const officialBundleSchema = new Set([
  "bundles_channel_id_idx",
  "bundles_channel_idx",
  "bundles_channel_insert_guard",
  "bundles_channel_update_guard",
  "bundles_fingerprint_hash_idx",
  "bundles_rollout_idx",
  "bundles_target_app_version_idx",
]);
const removedBundleColumns = [
  "should_force_update",
  "enabled",
  "message",
  "channel",
  "channel_id",
  "target_app_version",
  "fingerprint_hash",
  "rollout_cohort_count",
  "target_cohorts",
];

const replaceRegion = (
  source: string,
  startMarker: string,
  endMarker: string,
  body: readonly string[],
): string => {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker);
  if (start < 0 || end < start) {
    throw new Error("Cloudflare Release Catalog migration marker is missing.");
  }
  const replacement = [startMarker, ...body, endMarker].join("\n\n");
  return `${source.slice(0, start)}${replacement}${source.slice(
    end + endMarker.length,
  )}`;
};

const getRestorableBundleSchema = (
  rows: readonly D1BundleSchemaRow[],
): readonly string[] =>
  rows.flatMap((row) => {
    if (
      row.type === "table" ||
      row.sql === null ||
      officialBundleSchema.has(row.name)
    ) {
      return [];
    }
    const normalized = row.sql.toLowerCase();
    return removedBundleColumns.some((column) =>
      new RegExp(`\\b${column}\\b`).test(normalized),
    )
      ? []
      : [`${row.sql};`];
  });

export const materializeCloudflareReleaseCatalogMigration = async ({
  authorityId,
  migrationSql,
  state,
}: {
  readonly authorityId: string;
  readonly migrationSql: string;
  readonly state: D1ReleaseCatalogMigrationState;
}): Promise<string> => {
  const backfill = await compileLegacyReleaseCatalogBackfill({
    authorityId,
    rows: state.legacyBundles,
  });
  const inserts = createReleaseCatalogBackfillInsertSql({
    backfill,
    provider: "sqlite",
  }).map((statement) => `${statement};`);
  const withPreflight = replaceRegion(
    migrationSql,
    PREFLIGHT_START,
    PREFLIGHT_END,
    ["-- Legacy Bundle policy was preflighted by Hot Updater init."],
  );
  const withBackfill = replaceRegion(
    withPreflight,
    BACKFILL_START,
    BACKFILL_END,
    inserts.length === 0
      ? ["-- No legacy Bundle policy rows require backfill."]
      : inserts,
  );
  return replaceRegion(
    withBackfill,
    RESTORE_START,
    RESTORE_END,
    getRestorableBundleSchema(state.bundleSchema),
  );
};
