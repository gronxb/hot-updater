import { column, idColumn, schema, table } from "fumadb/schema";

export const v1 = schema({
  version: "1.0.0",
  tables: {
    bundles: table("bundles", {
      id: idColumn("id", "varchar(255)").defaultTo$("auto"),
      platform: column("platform", "string"),
      should_force_update: column("should_force_update", "bool"),
      enabled: column("enabled", "bool"),
      file_hash: column("file_hash", "string"),
      git_commit_hash: column("git_commit_hash", "string"),
      message: column("message", "string"),
      channel: column("channel", "string"),
      storage_uri: column("storage_uri", "string"),
      target_app_version: column("target_app_version", "string"),
      fingerprint_hash: column("fingerprint_hash", "string"),
      metadata: column("metadata", "json"),
    }),
  },
  relations: {},
});
