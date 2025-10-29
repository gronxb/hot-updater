import { column, idColumn, schema, table } from "fumadb/schema";

export const v0_21_0 = schema({
  version: "0.21.0",
  tables: {
    bundles: table("bundles", {
      id: idColumn("id", "varchar(255)").defaultTo$("auto"),
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
    }),
  },
  relations: {},
});
