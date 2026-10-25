-- HotUpdater.schema

CREATE TABLE IF NOT EXISTS "hot_updater_v1_native_builds" ("id" varchar(36) COLLATE "C" NOT NULL, "scope_key" varchar(2048) COLLATE "C" NOT NULL, "platform" varchar(16) COLLATE "C" NOT NULL, "channel_id" varchar(1408) COLLATE "C" NOT NULL, "fingerprint_hash" varchar(255) COLLATE "C", "app_version" text COLLATE "C", "min_bundle_id" varchar(36) COLLATE "C" NOT NULL, "artifact_kind" varchar(16) COLLATE "C" NOT NULL, "artifact_storage_uri" text COLLATE "C" NOT NULL, "byte_size" bigint NOT NULL, "git_commit_hash" varchar(255) COLLATE "C", "created_at_ms" bigint NOT NULL, "_v" bigint NOT NULL DEFAULT 0, PRIMARY KEY ("id"));

CREATE INDEX IF NOT EXISTS "hot_updater_v1_native_builds_byScope" ON "hot_updater_v1_native_builds" ("scope_key", "id");

CREATE INDEX IF NOT EXISTS "hot_updater_v1_native_builds_byChannel" ON "hot_updater_v1_native_builds" ("channel_id", "id");

CREATE UNIQUE INDEX IF NOT EXISTS "hot_updater_v1_native_builds_min_bundle_id" ON "hot_updater_v1_native_builds" ("min_bundle_id");

ALTER TABLE "hot_updater_v1_native_builds" ENABLE ROW LEVEL SECURITY;

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
      IF NOT target = ANY (ARRAY['hot_updater_v1_bundles', 'hot_updater_v1_bundle_patches', 'hot_updater_v1_releases', 'hot_updater_v1_release_catalogs', 'hot_updater_v1_channels', 'hot_updater_v1_bundle_totals', 'hot_updater_v1_native_builds', 'hot_updater_v1_bundle_events', 'hot_updater_v1_bundle_events__byBundle', 'hot_updater_v1_bundle_event_heads', 'hot_updater_v1_insights_overview', 'hot_updater_v1_insights_sketches', 'hot_updater_v1_insights_overview_daily', 'hot_updater_v1_insights_sketches_daily', 'hot_updater_v1_insights_overview_lifetime', 'hot_updater_v1_insights_sketches_lifetime', 'hot_updater_v1_insights_distribution', 'hot_updater_v1_insights_builtin_distribution', 'hot_updater_v1_insights_latest_by_bundle', 'hot_updater_v1_insights_outcomes', 'hot_updater_v1_insights_failures', 'hot_updater_v1_api_keys', 'hot_updater_v1_remote_config_active', 'hot_updater_v1_remote_config_versions', 'hot_updater_v1_private_hot_updater_settings', 'hot_updater_v1__hu_write']) THEN
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

INSERT INTO "hot_updater_v1_private_hot_updater_settings" ("key", "value", "_v") VALUES ('schema.core', '1.2.0', 0) ON CONFLICT ("key") DO UPDATE SET "value" = excluded."value";

INSERT INTO "hot_updater_v1_private_hot_updater_settings" ("key", "value", "_v") VALUES ('schema.insights', '1.0.0', 0) ON CONFLICT ("key") DO UPDATE SET "value" = excluded."value";

INSERT INTO "hot_updater_v1_private_hot_updater_settings" ("key", "value", "_v") VALUES ('schema.apiKeys', '1.0.0', 0) ON CONFLICT ("key") DO UPDATE SET "value" = excluded."value";

INSERT INTO "hot_updater_v1_private_hot_updater_settings" ("key", "value", "_v") VALUES ('schema.remoteConfig', '1.0.0', 0) ON CONFLICT ("key") DO UPDATE SET "value" = excluded."value";
