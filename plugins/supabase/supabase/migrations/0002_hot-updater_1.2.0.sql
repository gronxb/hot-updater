-- HotUpdater.schema

CREATE TABLE IF NOT EXISTS "hot_updater_v1_vault_secrets" ("id" varchar(64) COLLATE "C" NOT NULL, "name" varchar(64) COLLATE "C" NOT NULL, "kind" varchar(32) COLLATE "C" NOT NULL, "current_version" bigint NOT NULL, "metadata" jsonb NOT NULL, "created_at_ms" bigint NOT NULL, "updated_at_ms" bigint NOT NULL, "deleted_at_ms" bigint, "_v" bigint NOT NULL DEFAULT 0, PRIMARY KEY ("id"));

CREATE INDEX IF NOT EXISTS "hot_updater_v1_vault_secrets_byName" ON "hot_updater_v1_vault_secrets" ("name", "id");

CREATE UNIQUE INDEX IF NOT EXISTS "hot_updater_v1_vault_secrets_name" ON "hot_updater_v1_vault_secrets" ("name");

CREATE TABLE IF NOT EXISTS "hot_updater_v1_vault_secret_versions" ("secret_id" varchar(64) COLLATE "C" NOT NULL, "version" bigint NOT NULL, "kid" varchar(32) COLLATE "C" NOT NULL, "wrapped_dek" varchar(128) COLLATE "C" NOT NULL, "iv" varchar(32) COLLATE "C" NOT NULL, "ciphertext" varchar(100000) COLLATE "C" NOT NULL, "created_at_ms" bigint NOT NULL, "_v" bigint NOT NULL DEFAULT 0, PRIMARY KEY ("secret_id", "version"));

CREATE INDEX IF NOT EXISTS "hot_updater_v1_vault_secret_versions_byKid" ON "hot_updater_v1_vault_secret_versions" ("kid", "secret_id", "version");

CREATE TABLE IF NOT EXISTS "hot_updater_v1_vault_tokens" ("id" varchar(64) COLLATE "C" NOT NULL, "hash" varchar(64) COLLATE "C" NOT NULL, "name" varchar(64) COLLATE "C" NOT NULL, "prefix" varchar(16) COLLATE "C" NOT NULL, "scope" jsonb NOT NULL, "expires_at_ms" bigint, "created_at_ms" bigint NOT NULL, "revoked_at_ms" bigint, "_v" bigint NOT NULL DEFAULT 0, PRIMARY KEY ("id"));

CREATE INDEX IF NOT EXISTS "hot_updater_v1_vault_tokens_byCreated" ON "hot_updater_v1_vault_tokens" ("created_at_ms", "id");

CREATE UNIQUE INDEX IF NOT EXISTS "hot_updater_v1_vault_tokens_hash" ON "hot_updater_v1_vault_tokens" ("hash");

CREATE TABLE IF NOT EXISTS "hot_updater_v1_vault_audit" ("id" varchar(64) COLLATE "C" NOT NULL, "at_ms" bigint NOT NULL, "actor" varchar(255) COLLATE "C" NOT NULL, "action" varchar(16) COLLATE "C" NOT NULL, "secret_id" varchar(64) COLLATE "C", "outcome" varchar(16) COLLATE "C" NOT NULL, "context" jsonb NOT NULL, "_v" bigint NOT NULL DEFAULT 0, PRIMARY KEY ("id"));

CREATE INDEX IF NOT EXISTS "hot_updater_v1_vault_audit_byTime" ON "hot_updater_v1_vault_audit" ("at_ms", "id");

CREATE INDEX IF NOT EXISTS "hot_updater_v1_vault_audit_bySecret" ON "hot_updater_v1_vault_audit" ("secret_id", "at_ms", "id");

CREATE INDEX IF NOT EXISTS "hot_updater_v1_vault_audit_byActor" ON "hot_updater_v1_vault_audit" ("actor", "at_ms", "id");

ALTER TABLE "hot_updater_v1_vault_secrets" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "hot_updater_v1_vault_secret_versions" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "hot_updater_v1_vault_tokens" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "hot_updater_v1_vault_audit" ENABLE ROW LEVEL SECURITY;

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
      IF NOT target = ANY (ARRAY['hot_updater_v1_bundles', 'hot_updater_v1_bundle_patches', 'hot_updater_v1_releases', 'hot_updater_v1_release_catalogs', 'hot_updater_v1_channels', 'hot_updater_v1_bundle_totals', 'hot_updater_v1_bundle_events', 'hot_updater_v1_bundle_events__byBundle', 'hot_updater_v1_bundle_event_heads', 'hot_updater_v1_insights_overview', 'hot_updater_v1_insights_sketches', 'hot_updater_v1_insights_overview_daily', 'hot_updater_v1_insights_sketches_daily', 'hot_updater_v1_insights_overview_lifetime', 'hot_updater_v1_insights_sketches_lifetime', 'hot_updater_v1_insights_distribution', 'hot_updater_v1_insights_builtin_distribution', 'hot_updater_v1_insights_latest_by_bundle', 'hot_updater_v1_insights_outcomes', 'hot_updater_v1_insights_failures', 'hot_updater_v1_api_keys', 'hot_updater_v1_remote_config_active', 'hot_updater_v1_remote_config_versions', 'hot_updater_v1_vault_secrets', 'hot_updater_v1_vault_secret_versions', 'hot_updater_v1_vault_tokens', 'hot_updater_v1_vault_audit', 'hot_updater_v1_private_hot_updater_settings', 'hot_updater_v1__hu_write']) THEN
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

INSERT INTO "hot_updater_v1_private_hot_updater_settings" ("key", "value", "_v") VALUES ('schema.remoteConfig', '1.0.0', 0) ON CONFLICT ("key") DO UPDATE SET "value" = excluded."value";

INSERT INTO "hot_updater_v1_private_hot_updater_settings" ("key", "value", "_v") VALUES ('schema.vault', '1.0.0', 0) ON CONFLICT ("key") DO UPDATE SET "value" = excluded."value";
