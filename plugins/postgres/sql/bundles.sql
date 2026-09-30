-- HotUpdater.schema

CREATE TABLE IF NOT EXISTS "bundles" ("id" varchar(36) COLLATE "C" NOT NULL, "platform" varchar(16) COLLATE "C" NOT NULL, "git_commit_hash" varchar(255) COLLATE "C", "metadata" jsonb NOT NULL, "manifest_storage_uri" text COLLATE "C" NOT NULL, "manifest_file_hash" text COLLATE "C" NOT NULL, "asset_base_storage_uri" text COLLATE "C" NOT NULL, "_refs_bundle_patches_bundle_id" bigint NOT NULL DEFAULT 0, "_refs_bundle_patches_base_bundle_id" bigint NOT NULL DEFAULT 0, "_refs_releases_bundle_id" bigint NOT NULL DEFAULT 0, "_v" bigint NOT NULL DEFAULT 0, PRIMARY KEY ("id"));

CREATE INDEX IF NOT EXISTS "bundles_byPlatform" ON "bundles" ("platform", "id");

CREATE TABLE IF NOT EXISTS "bundle_patches" ("id" varchar(255) COLLATE "C" NOT NULL, "bundle_id" varchar(36) COLLATE "C" NOT NULL, "base_bundle_id" varchar(36) COLLATE "C" NOT NULL, "base_file_hash" text COLLATE "C" NOT NULL, "patch_file_hash" text COLLATE "C" NOT NULL, "patch_storage_uri" text COLLATE "C" NOT NULL, "byte_size" bigint NOT NULL, "order_index" bigint NOT NULL, "_v" bigint NOT NULL DEFAULT 0, PRIMARY KEY ("id"));

CREATE UNIQUE INDEX IF NOT EXISTS "bundle_patches_pair" ON "bundle_patches" ("bundle_id", "base_bundle_id");

CREATE INDEX IF NOT EXISTS "bundle_patches_byBundle" ON "bundle_patches" ("bundle_id", "order_index", "id");

CREATE INDEX IF NOT EXISTS "bundle_patches_byBase" ON "bundle_patches" ("base_bundle_id", "bundle_id", "id");

CREATE TABLE IF NOT EXISTS "releases" ("id" varchar(36) COLLATE "C" NOT NULL, "revision" bigint NOT NULL, "scope_key" varchar(2048) COLLATE "C" NOT NULL, "channel_id" varchar(1408) COLLATE "C" NOT NULL, "platform" varchar(16) COLLATE "C" NOT NULL, "kind" varchar(16) COLLATE "C" NOT NULL, "bundle_id" varchar(36) COLLATE "C", "strategy" varchar(16) COLLATE "C" NOT NULL, "target_app_version" text COLLATE "C", "fingerprint_hash" varchar(255) COLLATE "C", "enabled" boolean NOT NULL, "should_force_update" boolean NOT NULL, "message" text COLLATE "C", "rollout_cohort_count" bigint NOT NULL, "target_cohorts" jsonb NOT NULL, "operation" varchar(16) COLLATE "C" NOT NULL, "source_release_id" varchar(36) COLLATE "C", "created_at_ms" bigint NOT NULL, "updated_at_ms" bigint NOT NULL, "_v" bigint NOT NULL DEFAULT 0, PRIMARY KEY ("id"));

CREATE INDEX IF NOT EXISTS "releases_byScope" ON "releases" ("scope_key", "id");

CREATE INDEX IF NOT EXISTS "releases_byScopeEnabled" ON "releases" ("scope_key", "enabled", "id");

CREATE INDEX IF NOT EXISTS "releases_byChannelPlatform" ON "releases" ("channel_id", "platform", "id");

CREATE INDEX IF NOT EXISTS "releases_byChannelPlatformEnabled" ON "releases" ("channel_id", "platform", "enabled", "id");

CREATE INDEX IF NOT EXISTS "releases_byBundle" ON "releases" ("bundle_id", "id");

CREATE TABLE IF NOT EXISTS "release_catalogs" ("scope_key" varchar(2048) COLLATE "C" NOT NULL, "catalog_id" varchar(255) COLLATE "C" NOT NULL, "strategy" varchar(16) COLLATE "C" NOT NULL, "channel_id" varchar(1408) COLLATE "C" NOT NULL, "channel_key" varchar(1400) COLLATE "C" NOT NULL, "platform" varchar(16) COLLATE "C" NOT NULL, "fingerprint_hash" varchar(255) COLLATE "C", "generation" bigint NOT NULL, "payload" text COLLATE "C" NOT NULL, "catalog_hash" varchar(71) COLLATE "C" NOT NULL, "byte_size" bigint NOT NULL, "is_tombstone" boolean NOT NULL, "updated_at_ms" bigint NOT NULL, "_v" bigint NOT NULL DEFAULT 0, PRIMARY KEY ("scope_key"));

CREATE TABLE IF NOT EXISTS "channels" ("id" varchar(1408) COLLATE "C" NOT NULL, "name" varchar(255) COLLATE "C" NOT NULL, "_refs_releases_channel_id" bigint NOT NULL DEFAULT 0, "_v" bigint NOT NULL DEFAULT 0, PRIMARY KEY ("id"));

CREATE INDEX IF NOT EXISTS "channels_all" ON "channels" ("name", "id");

CREATE UNIQUE INDEX IF NOT EXISTS "channels_name" ON "channels" ("name");

CREATE TABLE IF NOT EXISTS "bundle_totals" ("platform_key" varchar(16) COLLATE "C" NOT NULL, "_shard" bigint NOT NULL, "bundles" bigint NOT NULL, "_v" bigint NOT NULL DEFAULT 0, PRIMARY KEY ("platform_key", "_shard"));

CREATE TABLE IF NOT EXISTS "private_hot_updater_settings" ("key" varchar(255) COLLATE "C" NOT NULL, "value" varchar(255) COLLATE "C" NOT NULL, "_v" bigint NOT NULL DEFAULT 0, PRIMARY KEY ("key"));

INSERT INTO "private_hot_updater_settings" ("key", "value", "_v") VALUES ('schema.engine', '1', 0) ON CONFLICT ("key") DO UPDATE SET "value" = excluded."value";

INSERT INTO "private_hot_updater_settings" ("key", "value", "_v") VALUES ('schema.core', '1.0.0', 0) ON CONFLICT ("key") DO UPDATE SET "value" = excluded."value";
