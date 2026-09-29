-- HotUpdater.schema

CREATE TABLE IF NOT EXISTS "bundles" ("id" varchar(36) COLLATE "C" NOT NULL, "platform" varchar(16) COLLATE "C" NOT NULL, "git_commit_hash" varchar(255) COLLATE "C", "metadata" jsonb NOT NULL, "manifest_storage_uri" text COLLATE "C" NOT NULL, "manifest_file_hash" text COLLATE "C" NOT NULL, "asset_base_storage_uri" text COLLATE "C" NOT NULL, "_refs_bundle_patches_bundle_id" bigint NOT NULL DEFAULT 0, "_refs_bundle_patches_base_bundle_id" bigint NOT NULL DEFAULT 0, "_refs_releases_bundle_id" bigint NOT NULL DEFAULT 0, "_v" bigint NOT NULL DEFAULT 0, PRIMARY KEY ("id"));

CREATE INDEX IF NOT EXISTS "bundles_byPlatform" ON "bundles" ("platform", "id");

CREATE TABLE IF NOT EXISTS "bundle_patches" ("id" varchar(255) COLLATE "C" NOT NULL, "bundle_id" varchar(36) COLLATE "C" NOT NULL, "base_bundle_id" varchar(36) COLLATE "C" NOT NULL, "base_file_hash" text COLLATE "C" NOT NULL, "patch_file_hash" text COLLATE "C" NOT NULL, "patch_storage_uri" text COLLATE "C" NOT NULL, "byte_size" bigint NOT NULL, "order_index" bigint NOT NULL, "_v" bigint NOT NULL DEFAULT 0, PRIMARY KEY ("id"));

CREATE UNIQUE INDEX IF NOT EXISTS "bundle_patches_pair" ON "bundle_patches" ("bundle_id", "base_bundle_id");

CREATE INDEX IF NOT EXISTS "bundle_patches_byBundle" ON "bundle_patches" ("bundle_id", "order_index", "id");

CREATE INDEX IF NOT EXISTS "bundle_patches_byBase" ON "bundle_patches" ("base_bundle_id", "bundle_id", "id");

CREATE TABLE IF NOT EXISTS "releases" ("id" varchar(36) COLLATE "C" NOT NULL, "revision" bigint NOT NULL, "scope_key" varchar(2048) COLLATE "C" NOT NULL, "channel_id" varchar(255) COLLATE "C" NOT NULL, "platform" varchar(16) COLLATE "C" NOT NULL, "kind" varchar(16) COLLATE "C" NOT NULL, "bundle_id" varchar(36) COLLATE "C", "strategy" varchar(16) COLLATE "C" NOT NULL, "target_app_version" text COLLATE "C", "fingerprint_hash" varchar(255) COLLATE "C", "enabled" boolean NOT NULL, "should_force_update" boolean NOT NULL, "message" text COLLATE "C", "rollout_cohort_count" bigint NOT NULL, "target_cohorts" jsonb NOT NULL, "operation" varchar(16) COLLATE "C" NOT NULL, "source_release_id" varchar(36) COLLATE "C", "created_at_ms" bigint NOT NULL, "updated_at_ms" bigint NOT NULL, "_v" bigint NOT NULL DEFAULT 0, PRIMARY KEY ("id"));

CREATE INDEX IF NOT EXISTS "releases_byScope" ON "releases" ("scope_key", "id");

CREATE INDEX IF NOT EXISTS "releases_byScopeEnabled" ON "releases" ("scope_key", "enabled", "id");

CREATE INDEX IF NOT EXISTS "releases_byChannelPlatform" ON "releases" ("channel_id", "platform", "id");

CREATE INDEX IF NOT EXISTS "releases_byChannelPlatformEnabled" ON "releases" ("channel_id", "platform", "enabled", "id");

CREATE INDEX IF NOT EXISTS "releases_byBundle" ON "releases" ("bundle_id", "id");

CREATE TABLE IF NOT EXISTS "release_catalogs" ("scope_key" varchar(2048) COLLATE "C" NOT NULL, "catalog_id" varchar(255) COLLATE "C" NOT NULL, "strategy" varchar(16) COLLATE "C" NOT NULL, "channel_id" varchar(255) COLLATE "C" NOT NULL, "channel_key" varchar(1400) COLLATE "C" NOT NULL, "platform" varchar(16) COLLATE "C" NOT NULL, "fingerprint_hash" varchar(255) COLLATE "C", "generation" bigint NOT NULL, "payload" text COLLATE "C" NOT NULL, "catalog_hash" varchar(71) COLLATE "C" NOT NULL, "byte_size" bigint NOT NULL, "is_tombstone" boolean NOT NULL, "updated_at_ms" bigint NOT NULL, "_v" bigint NOT NULL DEFAULT 0, PRIMARY KEY ("scope_key"));

CREATE TABLE IF NOT EXISTS "channels" ("id" varchar(255) COLLATE "C" NOT NULL, "name" varchar(255) COLLATE "C" NOT NULL, "_refs_releases_channel_id" bigint NOT NULL DEFAULT 0, "_v" bigint NOT NULL DEFAULT 0, PRIMARY KEY ("id"));

CREATE INDEX IF NOT EXISTS "channels_all" ON "channels" ("name", "id");

CREATE UNIQUE INDEX IF NOT EXISTS "channels_name" ON "channels" ("name");

CREATE TABLE IF NOT EXISTS "bundle_totals" ("platform_key" varchar(16) COLLATE "C" NOT NULL, "_shard" bigint NOT NULL, "bundles" bigint NOT NULL, "_v" bigint NOT NULL DEFAULT 0, PRIMARY KEY ("platform_key", "_shard"));

CREATE TABLE IF NOT EXISTS "base_candidates" ("candidate_key" varchar(2048) COLLATE "C" NOT NULL, "bundle_id" varchar(36) COLLATE "C" NOT NULL, "_shard" bigint NOT NULL, "releases" bigint NOT NULL, "_v" bigint NOT NULL DEFAULT 0, PRIMARY KEY ("candidate_key", "bundle_id", "_shard"));

CREATE TABLE IF NOT EXISTS "bundle_events" ("id" varchar(36) COLLATE "C" NOT NULL, "type" varchar(32) COLLATE "C" NOT NULL, "install_id" varchar(255) COLLATE "C" NOT NULL, "user_id" varchar(255) COLLATE "C", "from_release_id" varchar(36) COLLATE "C", "from_bundle_id" varchar(36) COLLATE "C", "to_release_id" varchar(36) COLLATE "C", "to_bundle_id" varchar(36) COLLATE "C" NOT NULL, "platform" varchar(16) COLLATE "C" NOT NULL, "app_version" text COLLATE "C" NOT NULL, "channel" text COLLATE "C" NOT NULL, "metadata" jsonb NOT NULL, "received_at_ms" bigint NOT NULL, "day" bigint, "movement_install_id" text COLLATE "C", "bundle_ref" jsonb, "_v" bigint NOT NULL DEFAULT 0, PRIMARY KEY ("id"));

CREATE INDEX IF NOT EXISTS "bundle_events_recent" ON "bundle_events" ("channel", "platform", "day", "received_at_ms", "id");

CREATE INDEX IF NOT EXISTS "bundle_events_movementsByInstall" ON "bundle_events" ("movement_install_id", "received_at_ms", "id");

CREATE TABLE IF NOT EXISTS "bundle_events__byBundle" ("platform" varchar(16) COLLATE "C" NOT NULL, "channel" text COLLATE "C" NOT NULL, "type" varchar(32) COLLATE "C" NOT NULL, "bundle_ref" text COLLATE "C" NOT NULL, "day" bigint NOT NULL, "received_at_ms" bigint NOT NULL, "id" varchar(36) COLLATE "C" NOT NULL, PRIMARY KEY ("platform", "channel", "type", "bundle_ref", "day", "received_at_ms", "id"));

CREATE INDEX IF NOT EXISTS "bundle_events_byDay" ON "bundle_events" ("day", "received_at_ms", "id");

CREATE TABLE IF NOT EXISTS "bundle_event_heads" ("install_id" varchar(255) COLLATE "C" NOT NULL, "id" varchar(36) COLLATE "C" NOT NULL, "type" varchar(32) COLLATE "C" NOT NULL, "user_id" varchar(255) COLLATE "C", "from_release_id" varchar(36) COLLATE "C", "from_bundle_id" varchar(36) COLLATE "C", "to_release_id" varchar(36) COLLATE "C", "to_bundle_id" varchar(36) COLLATE "C" NOT NULL, "platform" varchar(16) COLLATE "C" NOT NULL, "app_version" text COLLATE "C" NOT NULL, "channel" text COLLATE "C" NOT NULL, "metadata" jsonb NOT NULL, "received_at_ms" bigint NOT NULL, "current_release_id" varchar(36) COLLATE "C", "_v" bigint NOT NULL DEFAULT 0, PRIMARY KEY ("install_id"));

CREATE INDEX IF NOT EXISTS "bundle_event_heads_byUser" ON "bundle_event_heads" ("user_id", "install_id");

CREATE TABLE IF NOT EXISTS "insights_overview" ("identity" varchar(32) COLLATE "C" NOT NULL, "bucket_start_ms" bigint NOT NULL, "_shard" bigint NOT NULL, "downloads" bigint NOT NULL, "launches" bigint NOT NULL, "failed_launches" bigint NOT NULL, "_v" bigint NOT NULL DEFAULT 0, PRIMARY KEY ("identity", "bucket_start_ms", "_shard"));

CREATE TABLE IF NOT EXISTS "insights_sketches" ("identity" varchar(32) COLLATE "C" NOT NULL, "bucket_start_ms" bigint NOT NULL, "_shard" bigint NOT NULL, "launch_users" text COLLATE "C", "activity_users" text COLLATE "C", "_v" bigint NOT NULL DEFAULT 0, PRIMARY KEY ("identity", "bucket_start_ms", "_shard"));

CREATE TABLE IF NOT EXISTS "insights_distribution" ("channel" text COLLATE "C" NOT NULL, "platform" varchar(16) COLLATE "C" NOT NULL, "app_version" text COLLATE "C" NOT NULL, "release_id" varchar(36) COLLATE "C" NOT NULL, "bucket_start_ms" bigint NOT NULL, "_shard" bigint NOT NULL, "latest_installations" bigint NOT NULL, "_v" bigint NOT NULL DEFAULT 0, PRIMARY KEY ("channel", "platform", "app_version", "release_id", "bucket_start_ms", "_shard"));

CREATE INDEX IF NOT EXISTS "insights_distribution_byScope" ON "insights_distribution" ("channel", "platform", "bucket_start_ms", "app_version", "release_id", "_shard");

CREATE INDEX IF NOT EXISTS "insights_distribution_byVersion" ON "insights_distribution" ("channel", "platform", "app_version", "bucket_start_ms", "release_id", "_shard");

CREATE TABLE IF NOT EXISTS "insights_latest_by_bundle" ("platform" varchar(16) COLLATE "C" NOT NULL, "channel" text COLLATE "C" NOT NULL, "bundle_field" varchar(16) COLLATE "C" NOT NULL, "bundle_id" varchar(36) COLLATE "C" NOT NULL, "type" varchar(32) COLLATE "C" NOT NULL, "bucket_start_ms" bigint NOT NULL, "_shard" bigint NOT NULL, "installations" bigint NOT NULL, "_v" bigint NOT NULL DEFAULT 0, PRIMARY KEY ("platform", "channel", "bundle_field", "bundle_id", "type", "bucket_start_ms", "_shard"));

CREATE TABLE IF NOT EXISTS "insights_outcomes" ("platform" varchar(16) COLLATE "C" NOT NULL, "channel" text COLLATE "C" NOT NULL, "type" varchar(32) COLLATE "C" NOT NULL, "bundle_ref" varchar(41) COLLATE "C" NOT NULL, "bucket_start_ms" bigint NOT NULL, "_shard" bigint NOT NULL, "events" bigint NOT NULL, "_v" bigint NOT NULL DEFAULT 0, PRIMARY KEY ("platform", "channel", "type", "bundle_ref", "bucket_start_ms", "_shard"));

CREATE TABLE IF NOT EXISTS "api_keys" ("id" varchar(255) COLLATE "C" NOT NULL, "hash" varchar(64) COLLATE "C" NOT NULL, "name" varchar(64) COLLATE "C" NOT NULL, "prefix" varchar(16) COLLATE "C" NOT NULL, "role" varchar(16) COLLATE "C" NOT NULL, "created_at_ms" bigint NOT NULL, "revoked_at_ms" bigint, "_v" bigint NOT NULL DEFAULT 0, PRIMARY KEY ("id"));

CREATE INDEX IF NOT EXISTS "api_keys_byCreated" ON "api_keys" ("created_at_ms", "id");

CREATE UNIQUE INDEX IF NOT EXISTS "api_keys_hash" ON "api_keys" ("hash");

CREATE TABLE IF NOT EXISTS "private_hot_updater_settings" ("key" varchar(255) COLLATE "C" NOT NULL, "value" varchar(255) COLLATE "C" NOT NULL, "_v" bigint NOT NULL DEFAULT 0, PRIMARY KEY ("key"));

DO $$ BEGIN ALTER TABLE "bundle_patches" ADD CONSTRAINT "bundle_patches_bundle_id_fk" FOREIGN KEY ("bundle_id") REFERENCES "bundles" ("id") ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN ALTER TABLE "bundle_patches" ADD CONSTRAINT "bundle_patches_base_bundle_id_fk" FOREIGN KEY ("base_bundle_id") REFERENCES "bundles" ("id") ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN ALTER TABLE "releases" ADD CONSTRAINT "releases_channel_id_fk" FOREIGN KEY ("channel_id") REFERENCES "channels" ("id") ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN ALTER TABLE "releases" ADD CONSTRAINT "releases_bundle_id_fk" FOREIGN KEY ("bundle_id") REFERENCES "bundles" ("id") ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

INSERT INTO "private_hot_updater_settings" ("key", "value", "_v") VALUES ('schema.engine', '1', 0) ON CONFLICT ("key") DO UPDATE SET "value" = excluded."value";

INSERT INTO "private_hot_updater_settings" ("key", "value", "_v") VALUES ('schema.core', '1.0.0', 0) ON CONFLICT ("key") DO UPDATE SET "value" = excluded."value";

INSERT INTO "private_hot_updater_settings" ("key", "value", "_v") VALUES ('schema.insights', '1.0.0', 0) ON CONFLICT ("key") DO UPDATE SET "value" = excluded."value";

INSERT INTO "private_hot_updater_settings" ("key", "value", "_v") VALUES ('schema.apiKeys', '1.0.0', 0) ON CONFLICT ("key") DO UPDATE SET "value" = excluded."value";
