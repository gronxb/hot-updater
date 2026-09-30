-- HotUpdater.schema

CREATE TABLE IF NOT EXISTS "_hu_write" ("id" TEXT NOT NULL, "failed_op" INTEGER, PRIMARY KEY ("id"));

CREATE TABLE IF NOT EXISTS "bundles" ("id" TEXT NOT NULL, "platform" TEXT NOT NULL, "git_commit_hash" TEXT, "metadata" TEXT NOT NULL, "manifest_storage_uri" TEXT NOT NULL, "manifest_file_hash" TEXT NOT NULL, "asset_base_storage_uri" TEXT NOT NULL, "_refs_bundle_patches_bundle_id" INTEGER NOT NULL DEFAULT 0, "_refs_bundle_patches_base_bundle_id" INTEGER NOT NULL DEFAULT 0, "_refs_releases_bundle_id" INTEGER NOT NULL DEFAULT 0, "_v" INTEGER NOT NULL DEFAULT 0, PRIMARY KEY ("id"));

CREATE INDEX IF NOT EXISTS "bundles_byPlatform" ON "bundles" ("platform", "id");

CREATE TABLE IF NOT EXISTS "bundle_patches" ("id" TEXT NOT NULL, "bundle_id" TEXT NOT NULL, "base_bundle_id" TEXT NOT NULL, "base_file_hash" TEXT NOT NULL, "patch_file_hash" TEXT NOT NULL, "patch_storage_uri" TEXT NOT NULL, "byte_size" INTEGER NOT NULL, "order_index" INTEGER NOT NULL, "_v" INTEGER NOT NULL DEFAULT 0, PRIMARY KEY ("id"));

CREATE UNIQUE INDEX IF NOT EXISTS "bundle_patches_pair" ON "bundle_patches" ("bundle_id", "base_bundle_id");

CREATE INDEX IF NOT EXISTS "bundle_patches_byBundle" ON "bundle_patches" ("bundle_id", "order_index", "id");

CREATE INDEX IF NOT EXISTS "bundle_patches_byBase" ON "bundle_patches" ("base_bundle_id", "bundle_id", "id");

CREATE TABLE IF NOT EXISTS "releases" ("id" TEXT NOT NULL, "revision" INTEGER NOT NULL, "scope_key" TEXT NOT NULL, "channel_id" TEXT NOT NULL, "platform" TEXT NOT NULL, "kind" TEXT NOT NULL, "bundle_id" TEXT, "strategy" TEXT NOT NULL, "target_app_version" TEXT, "fingerprint_hash" TEXT, "enabled" INTEGER NOT NULL, "should_force_update" INTEGER NOT NULL, "message" TEXT, "rollout_cohort_count" INTEGER NOT NULL, "target_cohorts" TEXT NOT NULL, "operation" TEXT NOT NULL, "source_release_id" TEXT, "created_at_ms" INTEGER NOT NULL, "updated_at_ms" INTEGER NOT NULL, "_v" INTEGER NOT NULL DEFAULT 0, PRIMARY KEY ("id"));

CREATE INDEX IF NOT EXISTS "releases_byScope" ON "releases" ("scope_key", "id");

CREATE INDEX IF NOT EXISTS "releases_byScopeEnabled" ON "releases" ("scope_key", "enabled", "id");

CREATE INDEX IF NOT EXISTS "releases_byChannelPlatform" ON "releases" ("channel_id", "platform", "id");

CREATE INDEX IF NOT EXISTS "releases_byChannelPlatformEnabled" ON "releases" ("channel_id", "platform", "enabled", "id");

CREATE INDEX IF NOT EXISTS "releases_byBundle" ON "releases" ("bundle_id", "id");

CREATE TABLE IF NOT EXISTS "release_catalogs" ("scope_key" TEXT NOT NULL, "catalog_id" TEXT NOT NULL, "strategy" TEXT NOT NULL, "channel_id" TEXT NOT NULL, "channel_key" TEXT NOT NULL, "platform" TEXT NOT NULL, "fingerprint_hash" TEXT, "generation" INTEGER NOT NULL, "payload" TEXT NOT NULL, "catalog_hash" TEXT NOT NULL, "byte_size" INTEGER NOT NULL, "is_tombstone" INTEGER NOT NULL, "updated_at_ms" INTEGER NOT NULL, "_v" INTEGER NOT NULL DEFAULT 0, PRIMARY KEY ("scope_key"));

CREATE TABLE IF NOT EXISTS "channels" ("id" TEXT NOT NULL, "name" TEXT NOT NULL, "_refs_releases_channel_id" INTEGER NOT NULL DEFAULT 0, "_v" INTEGER NOT NULL DEFAULT 0, PRIMARY KEY ("id"));

CREATE INDEX IF NOT EXISTS "channels_all" ON "channels" ("name", "id");

CREATE UNIQUE INDEX IF NOT EXISTS "channels_name" ON "channels" ("name");

CREATE TABLE IF NOT EXISTS "bundle_totals" ("platform_key" TEXT NOT NULL, "_shard" INTEGER NOT NULL, "bundles" INTEGER NOT NULL, "_v" INTEGER NOT NULL DEFAULT 0, PRIMARY KEY ("platform_key", "_shard"));

CREATE TABLE IF NOT EXISTS "private_hot_updater_settings" ("key" TEXT NOT NULL, "value" TEXT NOT NULL, "_v" INTEGER NOT NULL DEFAULT 0, PRIMARY KEY ("key"));

INSERT INTO "private_hot_updater_settings" ("key", "value", "_v") VALUES ('schema.engine', '1', 0) ON CONFLICT ("key") DO UPDATE SET "value" = excluded."value";

INSERT INTO "private_hot_updater_settings" ("key", "value", "_v") VALUES ('schema.core', '1.0.0', 0) ON CONFLICT ("key") DO UPDATE SET "value" = excluded."value";
