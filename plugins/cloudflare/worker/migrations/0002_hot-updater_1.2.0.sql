-- HotUpdater.schema

CREATE TABLE IF NOT EXISTS "native_builds" ("id" TEXT NOT NULL, "scope_key" TEXT NOT NULL, "platform" TEXT NOT NULL, "channel_id" TEXT NOT NULL, "fingerprint_hash" TEXT, "app_version" TEXT, "min_bundle_id" TEXT NOT NULL, "artifact_kind" TEXT NOT NULL, "artifact_storage_uri" TEXT NOT NULL, "byte_size" INTEGER NOT NULL, "git_commit_hash" TEXT, "created_at_ms" INTEGER NOT NULL, "build_key" TEXT, "build_number" TEXT, "submitted_to" TEXT, "submitted_at_ms" INTEGER, "submitted_version" TEXT, "is_store_build" INTEGER NOT NULL, "is_sandbox" INTEGER NOT NULL, "sandbox_url_scheme" TEXT, "export_method" TEXT, "native_app_version" TEXT, "store_build_scope_key" TEXT, "_v" INTEGER NOT NULL DEFAULT 0, PRIMARY KEY ("id"));

CREATE INDEX IF NOT EXISTS "native_builds_byScope" ON "native_builds" ("scope_key", "id");

CREATE INDEX IF NOT EXISTS "native_builds_byBuildKey" ON "native_builds" ("scope_key", "build_key", "id");

CREATE INDEX IF NOT EXISTS "native_builds_byScopeKind" ON "native_builds" ("scope_key", "artifact_kind", "id");

CREATE UNIQUE INDEX IF NOT EXISTS "native_builds_byStoreBuild" ON "native_builds" ("store_build_scope_key");

CREATE INDEX IF NOT EXISTS "native_builds_byChannel" ON "native_builds" ("channel_id", "id");

CREATE UNIQUE INDEX IF NOT EXISTS "native_builds_min_bundle_id" ON "native_builds" ("min_bundle_id");

CREATE TABLE IF NOT EXISTS "ios_devices" ("id" TEXT NOT NULL, "udid" TEXT NOT NULL, "name" TEXT NOT NULL, "status" TEXT NOT NULL, "requested_by" TEXT, "created_at_ms" INTEGER NOT NULL, "approved_by" TEXT, "approved_at_ms" INTEGER, "registered_at_ms" INTEGER, "apple_issuer_id" TEXT, "apple_error" TEXT, "build_id" TEXT, "_v" INTEGER NOT NULL DEFAULT 0, PRIMARY KEY ("id"));

CREATE INDEX IF NOT EXISTS "ios_devices_byStatus" ON "ios_devices" ("status", "id");

CREATE UNIQUE INDEX IF NOT EXISTS "ios_devices_udid" ON "ios_devices" ("udid");

CREATE TABLE IF NOT EXISTS "ios_device_account" ("id" TEXT NOT NULL, "apple_issuer_id" TEXT NOT NULL, "claimed_at_ms" INTEGER NOT NULL, "_v" INTEGER NOT NULL DEFAULT 0, PRIMARY KEY ("id"));

CREATE INDEX IF NOT EXISTS "bundle_events__byBundle__key" ON "bundle_events__byBundle" ("id");

INSERT INTO "private_hot_updater_settings" ("key", "value", "_v") VALUES ('schema.engine', '1', 0) ON CONFLICT ("key") DO UPDATE SET "value" = excluded."value";

INSERT INTO "private_hot_updater_settings" ("key", "value", "_v") VALUES ('schema.core', '1.2.0', 0) ON CONFLICT ("key") DO UPDATE SET "value" = excluded."value";

INSERT INTO "private_hot_updater_settings" ("key", "value", "_v") VALUES ('schema.insights', '1.0.0', 0) ON CONFLICT ("key") DO UPDATE SET "value" = excluded."value";

INSERT INTO "private_hot_updater_settings" ("key", "value", "_v") VALUES ('schema.apiKeys', '1.0.0', 0) ON CONFLICT ("key") DO UPDATE SET "value" = excluded."value";

INSERT INTO "private_hot_updater_settings" ("key", "value", "_v") VALUES ('schema.remoteConfig', '1.0.0', 0) ON CONFLICT ("key") DO UPDATE SET "value" = excluded."value";
