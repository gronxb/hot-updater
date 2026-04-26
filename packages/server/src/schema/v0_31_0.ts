import { column, idColumn, schema, table } from "fumadb/schema";

export const v0_31_0 = schema({
  version: "0.31.0",
  tables: {
    bundles: table("bundles", {
      id: idColumn("id", "uuid"),
      platform: column("platform", "string"),
      should_force_update: column("should_force_update", "bool"),
      enabled: column("enabled", "bool"),
      file_hash: column("file_hash", "string"),
      git_commit_hash: column("git_commit_hash", "string").nullable(),
      message: column("message", "string").nullable(),
      channel: column("channel", "string"),
      storage_uri: column("storage_uri", "string"),
      target_app_version: column("target_app_version", "string").nullable(),
      fingerprint_hash: column("fingerprint_hash", "string").nullable(),
      metadata: column("metadata", "json"),
      manifest_storage_uri: column("manifest_storage_uri", "string").nullable(),
      manifest_file_hash: column("manifest_file_hash", "string").nullable(),
      asset_base_storage_uri: column(
        "asset_base_storage_uri",
        "string",
      ).nullable(),
      rollout_cohort_count: column("rollout_cohort_count", "integer").defaultTo(
        1000,
      ),
      target_cohorts: column("target_cohorts", "json").nullable(),
    }),
    bundle_patches: table("bundle_patches", {
      id: idColumn("id", "varchar(255)"),
      bundle_id: column("bundle_id", "uuid"),
      base_bundle_id: column("base_bundle_id", "uuid"),
      base_file_hash: column("base_file_hash", "string"),
      patch_file_hash: column("patch_file_hash", "string"),
      patch_storage_uri: column("patch_storage_uri", "string"),
      order_index: column("order_index", "integer").defaultTo(0),
    }),
  },
  relations: {},
});
