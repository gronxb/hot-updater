import { column, idColumn, schema, table } from "fumadb/schema";

export const v0_26_0 = schema({
  version: "0.26.0",
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
      rollout_percentage: column("rollout_percentage", "integer").defaultTo(
        100,
      ),
      target_device_ids: column("target_device_ids", "json").nullable(),
    }),
    device_events: table("device_events", {
      id: idColumn("id", "uuid"),
      device_id: column("device_id", "string"),
      bundle_id: column("bundle_id", "uuid"),
      event_type: column("event_type", "string"),
      platform: column("platform", "string"),
      app_version: column("app_version", "string").nullable(),
      channel: column("channel", "string"),
      metadata: column("metadata", "json"),
    }),
  },
  relations: {},
});
