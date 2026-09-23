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

CREATE TABLE IF NOT EXISTS "base_candidates" ("candidate_key" TEXT NOT NULL, "bundle_id" TEXT NOT NULL, "_shard" INTEGER NOT NULL, "releases" INTEGER NOT NULL, "_v" INTEGER NOT NULL DEFAULT 0, PRIMARY KEY ("candidate_key", "bundle_id", "_shard"));

CREATE TABLE IF NOT EXISTS "bundle_events" ("id" TEXT NOT NULL, "type" TEXT NOT NULL, "install_id" TEXT NOT NULL, "user_id" TEXT, "from_release_id" TEXT, "from_bundle_id" TEXT, "to_release_id" TEXT, "to_bundle_id" TEXT NOT NULL, "platform" TEXT NOT NULL, "app_version" TEXT NOT NULL, "channel" TEXT NOT NULL, "metadata" TEXT NOT NULL, "received_at_ms" INTEGER NOT NULL, "day" INTEGER, "movement_install_id" TEXT, "bundle_ref" TEXT, "_v" INTEGER NOT NULL DEFAULT 0, PRIMARY KEY ("id"));

CREATE INDEX IF NOT EXISTS "bundle_events_recent" ON "bundle_events" ("channel", "platform", "day", "received_at_ms", "id");

CREATE INDEX IF NOT EXISTS "bundle_events_movementsByInstall" ON "bundle_events" ("movement_install_id", "received_at_ms", "id");

CREATE TABLE IF NOT EXISTS "bundle_events__byBundle" ("platform" TEXT NOT NULL, "channel" TEXT NOT NULL, "type" TEXT NOT NULL, "bundle_ref" TEXT NOT NULL, "day" INTEGER NOT NULL, "received_at_ms" INTEGER NOT NULL, "id" TEXT NOT NULL, PRIMARY KEY ("platform", "channel", "type", "bundle_ref", "day", "received_at_ms", "id"));

CREATE INDEX IF NOT EXISTS "bundle_events_byDay" ON "bundle_events" ("day", "received_at_ms", "id");

CREATE TABLE IF NOT EXISTS "bundle_event_heads" ("install_id" TEXT NOT NULL, "id" TEXT NOT NULL, "type" TEXT NOT NULL, "user_id" TEXT, "from_release_id" TEXT, "from_bundle_id" TEXT, "to_release_id" TEXT, "to_bundle_id" TEXT NOT NULL, "platform" TEXT NOT NULL, "app_version" TEXT NOT NULL, "channel" TEXT NOT NULL, "metadata" TEXT NOT NULL, "received_at_ms" INTEGER NOT NULL, "current_release_id" TEXT, "_v" INTEGER NOT NULL DEFAULT 0, PRIMARY KEY ("install_id"));

CREATE INDEX IF NOT EXISTS "bundle_event_heads_byUser" ON "bundle_event_heads" ("user_id", "install_id");

CREATE TABLE IF NOT EXISTS "insights_overview" ("identity" TEXT NOT NULL, "bucket_start_ms" INTEGER NOT NULL, "_shard" INTEGER NOT NULL, "downloads" INTEGER NOT NULL, "launches" INTEGER NOT NULL, "failed_launches" INTEGER NOT NULL, "_v" INTEGER NOT NULL DEFAULT 0, PRIMARY KEY ("identity", "bucket_start_ms", "_shard"));

CREATE TABLE IF NOT EXISTS "insights_sketches" ("identity" TEXT NOT NULL, "bucket_start_ms" INTEGER NOT NULL, "_shard" INTEGER NOT NULL, "launch_users" TEXT, "activity_users" TEXT, "_v" INTEGER NOT NULL DEFAULT 0, PRIMARY KEY ("identity", "bucket_start_ms", "_shard"));

CREATE TABLE IF NOT EXISTS "insights_distribution" ("channel" TEXT NOT NULL, "platform" TEXT NOT NULL, "app_version" TEXT NOT NULL, "release_id" TEXT NOT NULL, "bucket_start_ms" INTEGER NOT NULL, "_shard" INTEGER NOT NULL, "latest_installations" INTEGER NOT NULL, "_v" INTEGER NOT NULL DEFAULT 0, PRIMARY KEY ("channel", "platform", "app_version", "release_id", "bucket_start_ms", "_shard"));

CREATE INDEX IF NOT EXISTS "insights_distribution_byScope" ON "insights_distribution" ("channel", "platform", "bucket_start_ms", "app_version", "release_id", "_shard");

CREATE INDEX IF NOT EXISTS "insights_distribution_byVersion" ON "insights_distribution" ("channel", "platform", "app_version", "bucket_start_ms", "release_id", "_shard");

CREATE TABLE IF NOT EXISTS "insights_latest_by_bundle" ("platform" TEXT NOT NULL, "channel" TEXT NOT NULL, "bundle_field" TEXT NOT NULL, "bundle_id" TEXT NOT NULL, "type" TEXT NOT NULL, "bucket_start_ms" INTEGER NOT NULL, "_shard" INTEGER NOT NULL, "installations" INTEGER NOT NULL, "_v" INTEGER NOT NULL DEFAULT 0, PRIMARY KEY ("platform", "channel", "bundle_field", "bundle_id", "type", "bucket_start_ms", "_shard"));

CREATE TABLE IF NOT EXISTS "insights_outcomes" ("platform" TEXT NOT NULL, "channel" TEXT NOT NULL, "type" TEXT NOT NULL, "bundle_ref" TEXT NOT NULL, "bucket_start_ms" INTEGER NOT NULL, "_shard" INTEGER NOT NULL, "events" INTEGER NOT NULL, "_v" INTEGER NOT NULL DEFAULT 0, PRIMARY KEY ("platform", "channel", "type", "bundle_ref", "bucket_start_ms", "_shard"));

CREATE TABLE IF NOT EXISTS "api_keys" ("id" TEXT NOT NULL, "hash" TEXT NOT NULL, "name" TEXT NOT NULL, "prefix" TEXT NOT NULL, "role" TEXT NOT NULL, "created_at_ms" INTEGER NOT NULL, "revoked_at_ms" INTEGER, "_v" INTEGER NOT NULL DEFAULT 0, PRIMARY KEY ("id"));

CREATE INDEX IF NOT EXISTS "api_keys_byCreated" ON "api_keys" ("created_at_ms", "id");

CREATE UNIQUE INDEX IF NOT EXISTS "api_keys_hash" ON "api_keys" ("hash");

CREATE TABLE IF NOT EXISTS "private_hot_updater_settings" ("key" TEXT NOT NULL, "value" TEXT NOT NULL, "_v" INTEGER NOT NULL DEFAULT 0, PRIMARY KEY ("key"));

INSERT INTO "private_hot_updater_settings" ("key", "value", "_v") VALUES ('schema.engine', '1', 0) ON CONFLICT ("key") DO UPDATE SET "value" = excluded."value";

INSERT INTO "private_hot_updater_settings" ("key", "value", "_v") VALUES ('schema.core', '1.0.0', 0) ON CONFLICT ("key") DO UPDATE SET "value" = excluded."value";

INSERT INTO "private_hot_updater_settings" ("key", "value", "_v") VALUES ('schema.insights', '1.0.0', 0) ON CONFLICT ("key") DO UPDATE SET "value" = excluded."value";

INSERT INTO "private_hot_updater_settings" ("key", "value", "_v") VALUES ('schema.apiKeys', '1.0.0', 0) ON CONFLICT ("key") DO UPDATE SET "value" = excluded."value";
