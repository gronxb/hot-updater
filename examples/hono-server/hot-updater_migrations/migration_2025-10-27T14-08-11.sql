CREATE TABLE "bundles" (
  "id" varchar(255) NOT NULL PRIMARY KEY,
  "platform" text NOT NULL,
  "should_force_update" boolean NOT NULL,
  "enabled" boolean NOT NULL,
  "file_hash" text NOT NULL,
  "git_commit_hash" text,
  "message" text,
  "channel" text NOT NULL,
  "storage_uri" text NOT NULL,
  "target_app_version" text,
  "fingerprint_hash" text,
  "metadata" json NOT NULL
);