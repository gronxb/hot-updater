-- HotUpdater.schema

CREATE TABLE IF NOT EXISTS "native_builds" ("id" TEXT NOT NULL, "scope_key" TEXT NOT NULL, "platform" TEXT NOT NULL, "channel_id" TEXT NOT NULL, "fingerprint_hash" TEXT, "app_version" TEXT, "min_bundle_id" TEXT NOT NULL, "artifact_kind" TEXT NOT NULL, "artifact_storage_uri" TEXT NOT NULL, "byte_size" INTEGER NOT NULL, "git_commit_hash" TEXT, "created_at_ms" INTEGER NOT NULL, "build_key" TEXT, "build_number" TEXT, "submitted_to" TEXT, "submitted_at_ms" INTEGER, "submitted_version" TEXT, "_v" INTEGER NOT NULL DEFAULT 0, PRIMARY KEY ("id"));

CREATE INDEX IF NOT EXISTS "native_builds_byScope" ON "native_builds" ("scope_key", "id");

CREATE INDEX IF NOT EXISTS "native_builds_byBuildKey" ON "native_builds" ("scope_key", "build_key", "id");

CREATE INDEX IF NOT EXISTS "native_builds_byChannel" ON "native_builds" ("channel_id", "id");

CREATE UNIQUE INDEX IF NOT EXISTS "native_builds_min_bundle_id" ON "native_builds" ("min_bundle_id");

INSERT INTO "private_hot_updater_settings" ("key", "value", "_v") VALUES ('schema.engine', '1', 0) ON CONFLICT ("key") DO UPDATE SET "value" = excluded."value";

INSERT INTO "private_hot_updater_settings" ("key", "value", "_v") VALUES ('schema.core', '1.2.0', 0) ON CONFLICT ("key") DO UPDATE SET "value" = excluded."value";

INSERT INTO "private_hot_updater_settings" ("key", "value", "_v") VALUES ('schema.insights', '1.0.0', 0) ON CONFLICT ("key") DO UPDATE SET "value" = excluded."value";

INSERT INTO "private_hot_updater_settings" ("key", "value", "_v") VALUES ('schema.apiKeys', '1.0.0', 0) ON CONFLICT ("key") DO UPDATE SET "value" = excluded."value";

INSERT INTO "private_hot_updater_settings" ("key", "value", "_v") VALUES ('schema.remoteConfig', '1.0.0', 0) ON CONFLICT ("key") DO UPDATE SET "value" = excluded."value";
