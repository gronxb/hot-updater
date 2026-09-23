-- HotUpdater.schema

CREATE TABLE IF NOT EXISTS "hot_updater_v1__hu_write" ("id" varchar(36) COLLATE "C" NOT NULL, "failed_op" bigint, PRIMARY KEY ("id"));

CREATE TABLE IF NOT EXISTS "hot_updater_v1_bundles" ("id" varchar(36) COLLATE "C" NOT NULL, "platform" varchar(16) COLLATE "C" NOT NULL, "git_commit_hash" varchar(255) COLLATE "C", "metadata" jsonb NOT NULL, "manifest_storage_uri" text COLLATE "C" NOT NULL, "manifest_file_hash" text COLLATE "C" NOT NULL, "asset_base_storage_uri" text COLLATE "C" NOT NULL, "_refs_bundle_patches_bundle_id" bigint NOT NULL DEFAULT 0, "_refs_bundle_patches_base_bundle_id" bigint NOT NULL DEFAULT 0, "_refs_releases_bundle_id" bigint NOT NULL DEFAULT 0, "_v" bigint NOT NULL DEFAULT 0, PRIMARY KEY ("id"));

CREATE INDEX IF NOT EXISTS "hot_updater_v1_bundles_byPlatform" ON "hot_updater_v1_bundles" ("platform", "id");

CREATE TABLE IF NOT EXISTS "hot_updater_v1_bundle_patches" ("id" varchar(255) COLLATE "C" NOT NULL, "bundle_id" varchar(36) COLLATE "C" NOT NULL, "base_bundle_id" varchar(36) COLLATE "C" NOT NULL, "base_file_hash" text COLLATE "C" NOT NULL, "patch_file_hash" text COLLATE "C" NOT NULL, "patch_storage_uri" text COLLATE "C" NOT NULL, "byte_size" bigint NOT NULL, "order_index" bigint NOT NULL, "_v" bigint NOT NULL DEFAULT 0, PRIMARY KEY ("id"));

CREATE UNIQUE INDEX IF NOT EXISTS "hot_updater_v1_bundle_patches_pair" ON "hot_updater_v1_bundle_patches" ("bundle_id", "base_bundle_id");

CREATE INDEX IF NOT EXISTS "hot_updater_v1_bundle_patches_byBundle" ON "hot_updater_v1_bundle_patches" ("bundle_id", "order_index", "id");

CREATE INDEX IF NOT EXISTS "hot_updater_v1_bundle_patches_byBase" ON "hot_updater_v1_bundle_patches" ("base_bundle_id", "bundle_id", "id");

CREATE TABLE IF NOT EXISTS "hot_updater_v1_releases" ("id" varchar(36) COLLATE "C" NOT NULL, "revision" bigint NOT NULL, "scope_key" varchar(2048) COLLATE "C" NOT NULL, "channel_id" varchar(255) COLLATE "C" NOT NULL, "platform" varchar(16) COLLATE "C" NOT NULL, "kind" varchar(16) COLLATE "C" NOT NULL, "bundle_id" varchar(36) COLLATE "C", "strategy" varchar(16) COLLATE "C" NOT NULL, "target_app_version" text COLLATE "C", "fingerprint_hash" varchar(255) COLLATE "C", "enabled" boolean NOT NULL, "should_force_update" boolean NOT NULL, "message" text COLLATE "C", "rollout_cohort_count" bigint NOT NULL, "target_cohorts" jsonb NOT NULL, "operation" varchar(16) COLLATE "C" NOT NULL, "source_release_id" varchar(36) COLLATE "C", "created_at_ms" bigint NOT NULL, "updated_at_ms" bigint NOT NULL, "_v" bigint NOT NULL DEFAULT 0, PRIMARY KEY ("id"));

CREATE INDEX IF NOT EXISTS "hot_updater_v1_releases_byScope" ON "hot_updater_v1_releases" ("scope_key", "id");

CREATE INDEX IF NOT EXISTS "hot_updater_v1_releases_byScopeEnabled" ON "hot_updater_v1_releases" ("scope_key", "enabled", "id");

CREATE INDEX IF NOT EXISTS "hot_updater_v1_releases_byChannelPlatform" ON "hot_updater_v1_releases" ("channel_id", "platform", "id");

CREATE INDEX IF NOT EXISTS "hot_updater_v1_releases_byChannelPlatformEnabled" ON "hot_updater_v1_releases" ("channel_id", "platform", "enabled", "id");

CREATE INDEX IF NOT EXISTS "hot_updater_v1_releases_byBundle" ON "hot_updater_v1_releases" ("bundle_id", "id");

CREATE TABLE IF NOT EXISTS "hot_updater_v1_release_catalogs" ("scope_key" varchar(2048) COLLATE "C" NOT NULL, "catalog_id" varchar(255) COLLATE "C" NOT NULL, "strategy" varchar(16) COLLATE "C" NOT NULL, "channel_id" varchar(255) COLLATE "C" NOT NULL, "channel_key" varchar(1400) COLLATE "C" NOT NULL, "platform" varchar(16) COLLATE "C" NOT NULL, "fingerprint_hash" varchar(255) COLLATE "C", "generation" bigint NOT NULL, "payload" text COLLATE "C" NOT NULL, "catalog_hash" varchar(71) COLLATE "C" NOT NULL, "byte_size" bigint NOT NULL, "is_tombstone" boolean NOT NULL, "updated_at_ms" bigint NOT NULL, "_v" bigint NOT NULL DEFAULT 0, PRIMARY KEY ("scope_key"));

CREATE TABLE IF NOT EXISTS "hot_updater_v1_channels" ("id" varchar(255) COLLATE "C" NOT NULL, "name" varchar(255) COLLATE "C" NOT NULL, "_refs_releases_channel_id" bigint NOT NULL DEFAULT 0, "_v" bigint NOT NULL DEFAULT 0, PRIMARY KEY ("id"));

CREATE INDEX IF NOT EXISTS "hot_updater_v1_channels_all" ON "hot_updater_v1_channels" ("name", "id");

CREATE UNIQUE INDEX IF NOT EXISTS "hot_updater_v1_channels_name" ON "hot_updater_v1_channels" ("name");

CREATE TABLE IF NOT EXISTS "hot_updater_v1_bundle_totals" ("platform_key" varchar(16) COLLATE "C" NOT NULL, "_shard" bigint NOT NULL, "bundles" bigint NOT NULL, "_v" bigint NOT NULL DEFAULT 0, PRIMARY KEY ("platform_key", "_shard"));

CREATE TABLE IF NOT EXISTS "hot_updater_v1_base_candidates" ("candidate_key" varchar(2048) COLLATE "C" NOT NULL, "bundle_id" varchar(36) COLLATE "C" NOT NULL, "_shard" bigint NOT NULL, "releases" bigint NOT NULL, "_v" bigint NOT NULL DEFAULT 0, PRIMARY KEY ("candidate_key", "bundle_id", "_shard"));

CREATE TABLE IF NOT EXISTS "hot_updater_v1_bundle_events" ("id" varchar(36) COLLATE "C" NOT NULL, "type" varchar(32) COLLATE "C" NOT NULL, "install_id" varchar(255) COLLATE "C" NOT NULL, "user_id" varchar(255) COLLATE "C", "from_release_id" varchar(36) COLLATE "C", "from_bundle_id" varchar(36) COLLATE "C", "to_release_id" varchar(36) COLLATE "C", "to_bundle_id" varchar(36) COLLATE "C" NOT NULL, "platform" varchar(16) COLLATE "C" NOT NULL, "app_version" text COLLATE "C" NOT NULL, "channel" text COLLATE "C" NOT NULL, "metadata" jsonb NOT NULL, "received_at_ms" bigint NOT NULL, "day" bigint, "movement_install_id" text COLLATE "C", "bundle_ref" jsonb, "_v" bigint NOT NULL DEFAULT 0, PRIMARY KEY ("id"));

CREATE INDEX IF NOT EXISTS "hot_updater_v1_bundle_events_recent" ON "hot_updater_v1_bundle_events" ("channel", "platform", "day", "received_at_ms", "id");

CREATE INDEX IF NOT EXISTS "hot_updater_v1_bundle_events_movementsByInstall" ON "hot_updater_v1_bundle_events" ("movement_install_id", "received_at_ms", "id");

CREATE TABLE IF NOT EXISTS "hot_updater_v1_bundle_events__byBundle" ("platform" varchar(16) COLLATE "C" NOT NULL, "channel" text COLLATE "C" NOT NULL, "type" varchar(32) COLLATE "C" NOT NULL, "bundle_ref" text COLLATE "C" NOT NULL, "day" bigint NOT NULL, "received_at_ms" bigint NOT NULL, "id" varchar(36) COLLATE "C" NOT NULL, PRIMARY KEY ("platform", "channel", "type", "bundle_ref", "day", "received_at_ms", "id"));

CREATE INDEX IF NOT EXISTS "hot_updater_v1_bundle_events_byDay" ON "hot_updater_v1_bundle_events" ("day", "received_at_ms", "id");

CREATE TABLE IF NOT EXISTS "hot_updater_v1_bundle_event_heads" ("install_id" varchar(255) COLLATE "C" NOT NULL, "id" varchar(36) COLLATE "C" NOT NULL, "type" varchar(32) COLLATE "C" NOT NULL, "user_id" varchar(255) COLLATE "C", "from_release_id" varchar(36) COLLATE "C", "from_bundle_id" varchar(36) COLLATE "C", "to_release_id" varchar(36) COLLATE "C", "to_bundle_id" varchar(36) COLLATE "C" NOT NULL, "platform" varchar(16) COLLATE "C" NOT NULL, "app_version" text COLLATE "C" NOT NULL, "channel" text COLLATE "C" NOT NULL, "metadata" jsonb NOT NULL, "received_at_ms" bigint NOT NULL, "current_release_id" varchar(36) COLLATE "C", "_v" bigint NOT NULL DEFAULT 0, PRIMARY KEY ("install_id"));

CREATE INDEX IF NOT EXISTS "hot_updater_v1_bundle_event_heads_byUser" ON "hot_updater_v1_bundle_event_heads" ("user_id", "install_id");

CREATE TABLE IF NOT EXISTS "hot_updater_v1_insights_overview" ("identity" varchar(32) COLLATE "C" NOT NULL, "bucket_start_ms" bigint NOT NULL, "_shard" bigint NOT NULL, "downloads" bigint NOT NULL, "launches" bigint NOT NULL, "failed_launches" bigint NOT NULL, "_v" bigint NOT NULL DEFAULT 0, PRIMARY KEY ("identity", "bucket_start_ms", "_shard"));

CREATE TABLE IF NOT EXISTS "hot_updater_v1_insights_sketches" ("identity" varchar(32) COLLATE "C" NOT NULL, "bucket_start_ms" bigint NOT NULL, "_shard" bigint NOT NULL, "launch_users" text COLLATE "C", "activity_users" text COLLATE "C", "_v" bigint NOT NULL DEFAULT 0, PRIMARY KEY ("identity", "bucket_start_ms", "_shard"));

CREATE TABLE IF NOT EXISTS "hot_updater_v1_insights_distribution" ("channel" text COLLATE "C" NOT NULL, "platform" varchar(16) COLLATE "C" NOT NULL, "app_version" text COLLATE "C" NOT NULL, "release_id" varchar(36) COLLATE "C" NOT NULL, "bucket_start_ms" bigint NOT NULL, "_shard" bigint NOT NULL, "latest_installations" bigint NOT NULL, "_v" bigint NOT NULL DEFAULT 0, PRIMARY KEY ("channel", "platform", "app_version", "release_id", "bucket_start_ms", "_shard"));

CREATE INDEX IF NOT EXISTS "hot_updater_v1_insights_distribution_byScope" ON "hot_updater_v1_insights_distribution" ("channel", "platform", "bucket_start_ms", "app_version", "release_id", "_shard");

CREATE INDEX IF NOT EXISTS "hot_updater_v1_insights_distribution_byVersion" ON "hot_updater_v1_insights_distribution" ("channel", "platform", "app_version", "bucket_start_ms", "release_id", "_shard");

CREATE TABLE IF NOT EXISTS "hot_updater_v1_insights_latest_by_bundle" ("platform" varchar(16) COLLATE "C" NOT NULL, "channel" text COLLATE "C" NOT NULL, "bundle_field" varchar(16) COLLATE "C" NOT NULL, "bundle_id" varchar(36) COLLATE "C" NOT NULL, "type" varchar(32) COLLATE "C" NOT NULL, "bucket_start_ms" bigint NOT NULL, "_shard" bigint NOT NULL, "installations" bigint NOT NULL, "_v" bigint NOT NULL DEFAULT 0, PRIMARY KEY ("platform", "channel", "bundle_field", "bundle_id", "type", "bucket_start_ms", "_shard"));

CREATE TABLE IF NOT EXISTS "hot_updater_v1_insights_outcomes" ("platform" varchar(16) COLLATE "C" NOT NULL, "channel" text COLLATE "C" NOT NULL, "type" varchar(32) COLLATE "C" NOT NULL, "bundle_ref" varchar(41) COLLATE "C" NOT NULL, "bucket_start_ms" bigint NOT NULL, "_shard" bigint NOT NULL, "events" bigint NOT NULL, "_v" bigint NOT NULL DEFAULT 0, PRIMARY KEY ("platform", "channel", "type", "bundle_ref", "bucket_start_ms", "_shard"));

CREATE TABLE IF NOT EXISTS "hot_updater_v1_api_keys" ("id" varchar(255) COLLATE "C" NOT NULL, "hash" varchar(64) COLLATE "C" NOT NULL, "name" varchar(64) COLLATE "C" NOT NULL, "prefix" varchar(16) COLLATE "C" NOT NULL, "role" varchar(16) COLLATE "C" NOT NULL, "created_at_ms" bigint NOT NULL, "revoked_at_ms" bigint, "_v" bigint NOT NULL DEFAULT 0, PRIMARY KEY ("id"));

CREATE INDEX IF NOT EXISTS "hot_updater_v1_api_keys_byCreated" ON "hot_updater_v1_api_keys" ("created_at_ms", "id");

CREATE UNIQUE INDEX IF NOT EXISTS "hot_updater_v1_api_keys_hash" ON "hot_updater_v1_api_keys" ("hash");

CREATE TABLE IF NOT EXISTS "hot_updater_v1_private_hot_updater_settings" ("key" varchar(255) COLLATE "C" NOT NULL, "value" varchar(255) COLLATE "C" NOT NULL, "_v" bigint NOT NULL DEFAULT 0, PRIMARY KEY ("key"));

DO $$ BEGIN ALTER TABLE "hot_updater_v1_bundle_patches" ADD CONSTRAINT "hot_updater_v1_bundle_patches_bundle_id_fk" FOREIGN KEY ("bundle_id") REFERENCES "hot_updater_v1_bundles" ("id") ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN ALTER TABLE "hot_updater_v1_bundle_patches" ADD CONSTRAINT "hot_updater_v1_bundle_patches_base_bundle_id_fk" FOREIGN KEY ("base_bundle_id") REFERENCES "hot_updater_v1_bundles" ("id") ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN ALTER TABLE "hot_updater_v1_releases" ADD CONSTRAINT "hot_updater_v1_releases_channel_id_fk" FOREIGN KEY ("channel_id") REFERENCES "hot_updater_v1_channels" ("id") ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN ALTER TABLE "hot_updater_v1_releases" ADD CONSTRAINT "hot_updater_v1_releases_bundle_id_fk" FOREIGN KEY ("bundle_id") REFERENCES "hot_updater_v1_bundles" ("id") ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "hot_updater_v1_bundles" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "hot_updater_v1_bundle_patches" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "hot_updater_v1_releases" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "hot_updater_v1_release_catalogs" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "hot_updater_v1_channels" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "hot_updater_v1_bundle_totals" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "hot_updater_v1_base_candidates" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "hot_updater_v1_bundle_events" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "hot_updater_v1_bundle_events__byBundle" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "hot_updater_v1_bundle_event_heads" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "hot_updater_v1_insights_overview" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "hot_updater_v1_insights_sketches" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "hot_updater_v1_insights_distribution" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "hot_updater_v1_insights_latest_by_bundle" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "hot_updater_v1_insights_outcomes" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "hot_updater_v1_api_keys" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "hot_updater_v1_private_hot_updater_settings" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "hot_updater_v1__hu_write" ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.hot_updater_v1_apply(p_statements jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $apply$
DECLARE
  item jsonb;
  statement text;
  shape text;
  target text;
  found record;
  rows jsonb;
  changed bigint;
  results jsonb := '[]'::jsonb;
BEGIN
  FOR item IN SELECT value FROM jsonb_array_elements(p_statements) LOOP
    statement := item->>'sql';
    FOR target IN SELECT (regexp_matches(statement, '(?:FROM|INTO|UPDATE|JOIN) "([^"]+)"', 'g'))[1] LOOP
      IF NOT target = ANY (ARRAY['hot_updater_v1_bundles', 'hot_updater_v1_bundle_patches', 'hot_updater_v1_releases', 'hot_updater_v1_release_catalogs', 'hot_updater_v1_channels', 'hot_updater_v1_bundle_totals', 'hot_updater_v1_base_candidates', 'hot_updater_v1_bundle_events', 'hot_updater_v1_bundle_events__byBundle', 'hot_updater_v1_bundle_event_heads', 'hot_updater_v1_insights_overview', 'hot_updater_v1_insights_sketches', 'hot_updater_v1_insights_distribution', 'hot_updater_v1_insights_latest_by_bundle', 'hot_updater_v1_insights_outcomes', 'hot_updater_v1_api_keys', 'hot_updater_v1_private_hot_updater_settings', 'hot_updater_v1__hu_write']) THEN
        RAISE EXCEPTION 'hot_updater_v1_apply: % is not a Hot Updater table', target USING ERRCODE = '42501';
      END IF;
    END LOOP;
    shape := regexp_replace(regexp_replace(statement, '^INSERT INTO "[^"]+" \(', 'INSERT INTO ('), '"[^"]*"', '"', 'g');
    IF shape !~ '^(SELECT|INSERT INTO|UPDATE|DELETE FROM) '
      OR shape ~ '"[[:space:]]*\('
      OR shape ~ '[;''\\]|--|/\*'
      OR regexp_replace(shape, '\m(SELECT|FROM|WHERE|AND|OR|NOT|EXISTS|INSERT|INTO|VALUES|UPDATE|SET|DELETE|ORDER|BY|ASC|DESC|LIMIT|IS|NULL|ON|CONFLICT|DO|JOIN|FOR|bigint|double|precision|boolean|jsonb|i|b)\M', '', 'gi') !~ '^[[:space:]"(),.*=<>+0-9$:-]*$' THEN
      RAISE EXCEPTION 'hot_updater_v1_apply: statement not allowed' USING ERRCODE = '42501';
    END IF;
    IF statement ~ '^SELECT ' THEN
      rows := '[]'::jsonb;
      FOR found IN EXECUTE statement USING item->'params' LOOP
        rows := rows || jsonb_build_array(to_jsonb(found));
      END LOOP;
      results := results || jsonb_build_array(jsonb_build_object('rows', rows, 'changes', 0));
    ELSE
      EXECUTE statement USING item->'params';
      GET DIAGNOSTICS changed = ROW_COUNT;
      results := results || jsonb_build_array(jsonb_build_object('rows', '[]'::jsonb, 'changes', changed));
    END IF;
  END LOOP;
  RETURN results;
END;
$apply$;

REVOKE EXECUTE ON FUNCTION public.hot_updater_v1_apply(jsonb) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.hot_updater_v1_apply(jsonb) TO service_role;

INSERT INTO "hot_updater_v1_private_hot_updater_settings" ("key", "value", "_v") VALUES ('schema.engine', '1', 0) ON CONFLICT ("key") DO UPDATE SET "value" = excluded."value";

INSERT INTO "hot_updater_v1_private_hot_updater_settings" ("key", "value", "_v") VALUES ('schema.core', '1.0.0', 0) ON CONFLICT ("key") DO UPDATE SET "value" = excluded."value";

INSERT INTO "hot_updater_v1_private_hot_updater_settings" ("key", "value", "_v") VALUES ('schema.insights', '1.0.0', 0) ON CONFLICT ("key") DO UPDATE SET "value" = excluded."value";

INSERT INTO "hot_updater_v1_private_hot_updater_settings" ("key", "value", "_v") VALUES ('schema.apiKeys', '1.0.0', 0) ON CONFLICT ("key") DO UPDATE SET "value" = excluded."value";
