-- HotUpdater.schema

CREATE TABLE public.hot_updater_v1_channels (
  id text COLLATE "C" PRIMARY KEY NOT NULL
    CHECK (pg_catalog.char_length(id) BETWEEN 1 AND 255),
  name text COLLATE "C" NOT NULL UNIQUE
    CHECK (pg_catalog.char_length(name) BETWEEN 1 AND 255)
);

CREATE TABLE public.hot_updater_v1_bundles (
  id uuid PRIMARY KEY NOT NULL,
  platform text NOT NULL,
  file_hash text NOT NULL,
  git_commit_hash text,
  storage_uri text NOT NULL,
  archive_byte_size double precision NOT NULL CHECK (
    archive_byte_size BETWEEN 0 AND 9007199254740991
  ),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  manifest_storage_uri text,
  manifest_file_hash text,
  asset_base_storage_uri text
);

CREATE TABLE public.hot_updater_v1_bundle_patches (
  id varchar(255) PRIMARY KEY NOT NULL,
  bundle_id uuid NOT NULL,
  base_bundle_id uuid NOT NULL,
  base_file_hash text NOT NULL,
  patch_file_hash text NOT NULL,
  patch_storage_uri text NOT NULL,
  byte_size double precision NOT NULL CHECK (
    byte_size BETWEEN 0 AND 9007199254740991
  ),
  order_index integer NOT NULL DEFAULT 0,
  CONSTRAINT hot_updater_v1_bundle_patches_bundle_id_fk FOREIGN KEY (bundle_id)
    REFERENCES public.hot_updater_v1_bundles(id) ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT hot_updater_v1_bundle_patches_base_bundle_id_fk FOREIGN KEY (base_bundle_id)
    REFERENCES public.hot_updater_v1_bundles(id) ON UPDATE RESTRICT ON DELETE CASCADE
);

CREATE TABLE public.hot_updater_v1_releases (
  id uuid PRIMARY KEY NOT NULL,
  revision integer NOT NULL CHECK (revision >= 1),
  scope_key varchar(2048) COLLATE "C" NOT NULL,
  channel_id text COLLATE "C" NOT NULL,
  platform text NOT NULL,
  kind text NOT NULL CHECK (
    (kind = 'BUNDLE' AND bundle_id IS NOT NULL)
    OR (kind = 'EMBEDDED' AND bundle_id IS NULL)
  ),
  bundle_id uuid,
  strategy text NOT NULL,
  target_app_version text,
  fingerprint_hash text,
  enabled boolean NOT NULL,
  should_force_update boolean NOT NULL,
  message text,
  rollout_cohort_count integer NOT NULL DEFAULT 1000
    CHECK (rollout_cohort_count BETWEEN 0 AND 1000),
  target_cohorts jsonb NOT NULL DEFAULT '[]'::jsonb,
  operation text NOT NULL CHECK (operation IN ('DEPLOY', 'PROMOTE', 'ROLLBACK')),
  source_release_id uuid,
  created_at_ms double precision NOT NULL,
  updated_at_ms double precision NOT NULL,
  CONSTRAINT hot_updater_v1_releases_strategy_target_check CHECK (
    (strategy = 'APP_VERSION' AND target_app_version IS NOT NULL AND fingerprint_hash IS NULL)
    OR (strategy = 'FINGERPRINT' AND target_app_version IS NULL AND fingerprint_hash IS NOT NULL)
  ),
  CONSTRAINT hot_updater_v1_releases_channel_id_fk FOREIGN KEY (channel_id)
    REFERENCES public.hot_updater_v1_channels(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT hot_updater_v1_releases_bundle_id_fk FOREIGN KEY (bundle_id)
    REFERENCES public.hot_updater_v1_bundles(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT hot_updater_v1_releases_source_release_id_fk FOREIGN KEY (source_release_id)
    REFERENCES public.hot_updater_v1_releases(id) ON UPDATE RESTRICT ON DELETE SET NULL
);

CREATE TABLE public.hot_updater_v1_release_catalogs (
  scope_key varchar(2048) COLLATE "C" PRIMARY KEY NOT NULL,
  catalog_id varchar(255) COLLATE "C" NOT NULL,
  strategy text NOT NULL,
  channel_id text COLLATE "C" NOT NULL,
  channel_key varchar(1400) COLLATE "C" NOT NULL,
  platform text NOT NULL,
  fingerprint_hash text,
  generation double precision NOT NULL
    CHECK (generation BETWEEN 1 AND 9007199254740991),
  payload text NOT NULL,
  catalog_hash varchar(71) COLLATE "C" NOT NULL,
  byte_size integer NOT NULL CHECK (byte_size BETWEEN 0 AND 262144),
  is_tombstone boolean NOT NULL,
  updated_at_ms double precision NOT NULL,
  CONSTRAINT hot_updater_v1_release_catalogs_strategy_target_check CHECK (
    (strategy = 'APP_VERSION' AND fingerprint_hash IS NULL)
    OR (strategy = 'FINGERPRINT' AND fingerprint_hash IS NOT NULL)
  ),
  CONSTRAINT hot_updater_v1_release_catalogs_channel_id_fk FOREIGN KEY (channel_id)
    REFERENCES public.hot_updater_v1_channels(id) ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE TABLE public.hot_updater_v1_bundle_events (
  id uuid PRIMARY KEY NOT NULL,
  type text NOT NULL,
  install_id text COLLATE "C" NOT NULL,
  user_id text COLLATE "C",
  from_release_id uuid,
  from_bundle_id uuid,
  to_release_id uuid,
  to_bundle_id uuid NOT NULL,
  platform text COLLATE "C" NOT NULL,
  app_version text NOT NULL,
  channel text COLLATE "C" NOT NULL,
  metadata JSONB NOT NULL,
  received_at_ms double precision NOT NULL,
  CONSTRAINT hot_updater_v1_bundle_events_type_check CHECK (
    type IN ('UPDATE_DOWNLOADED', 'UPDATE_APPLIED', 'RECOVERED', 'UNCHANGED')
  ),
  CONSTRAINT hot_updater_v1_bundle_events_platform_check CHECK (
    platform IN ('ios', 'android')
  ),
  CONSTRAINT hot_updater_v1_bundle_events_shape_check CHECK (
    (type IN ('UPDATE_DOWNLOADED', 'UPDATE_APPLIED', 'RECOVERED')
      AND from_bundle_id IS NOT NULL)
    OR (type = 'UNCHANGED'
      AND from_bundle_id IS NULL)
  ),
  CONSTRAINT hot_updater_v1_bundle_events_received_at_check CHECK (received_at_ms >= 0)
);


CREATE TABLE public.hot_updater_v1_api_keys (
  id text PRIMARY KEY NOT NULL,
  hash text NOT NULL,
  name text NOT NULL,
  prefix text NOT NULL,
  role text NOT NULL CHECK (role = 'client'),
  created_at_ms double precision NOT NULL CHECK (created_at_ms >= 0),
  revoked_at_ms double precision CHECK (
    revoked_at_ms IS NULL OR revoked_at_ms >= 0
  )
);

CREATE TABLE public.hot_updater_v1_private_settings (
  key varchar(255) PRIMARY KEY NOT NULL,
  value text NOT NULL DEFAULT '1.0.0'
);

CREATE INDEX hot_updater_v1_releases_scope_order_idx ON public.hot_updater_v1_releases(scope_key, id);
CREATE INDEX hot_updater_v1_releases_channel_platform_order_idx
  ON public.hot_updater_v1_releases(channel_id, platform, id);
CREATE INDEX hot_updater_v1_releases_bundle_id_idx ON public.hot_updater_v1_releases(bundle_id);
CREATE INDEX hot_updater_v1_releases_fingerprint_hash_idx ON public.hot_updater_v1_releases(fingerprint_hash);
CREATE INDEX hot_updater_v1_releases_enabled_idx ON public.hot_updater_v1_releases(enabled);
CREATE INDEX hot_updater_v1_release_catalogs_channel_idx ON public.hot_updater_v1_release_catalogs(channel_id);
CREATE INDEX hot_updater_v1_bundle_patches_bundle_id_idx ON public.hot_updater_v1_bundle_patches(bundle_id);
CREATE INDEX hot_updater_v1_bundle_patches_base_bundle_id_idx
  ON public.hot_updater_v1_bundle_patches(base_bundle_id);
CREATE INDEX hot_updater_v1_bundle_events_received_at_idx
  ON public.hot_updater_v1_bundle_events(received_at_ms, id);
CREATE INDEX hot_updater_v1_bundle_events_install_idx
  ON public.hot_updater_v1_bundle_events(install_id, type, received_at_ms, id);
CREATE INDEX hot_updater_v1_bundle_events_from_bundle_idx
  ON public.hot_updater_v1_bundle_events(type, platform, channel, from_bundle_id, received_at_ms, id);
CREATE INDEX hot_updater_v1_bundle_events_to_bundle_idx
  ON public.hot_updater_v1_bundle_events(type, platform, channel, to_bundle_id, received_at_ms, id);
CREATE UNIQUE INDEX hot_updater_v1_api_keys_hash_key
  ON public.hot_updater_v1_api_keys(hash);
CREATE INDEX hot_updater_v1_api_keys_created_at_idx
  ON public.hot_updater_v1_api_keys(created_at_ms, id);

ALTER TABLE public.hot_updater_v1_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hot_updater_v1_bundles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hot_updater_v1_bundle_patches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hot_updater_v1_releases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hot_updater_v1_release_catalogs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hot_updater_v1_bundle_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hot_updater_v1_api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hot_updater_v1_private_settings ENABLE ROW LEVEL SECURITY;

INSERT INTO public.hot_updater_v1_private_settings (key, value)
VALUES ('schema.core', '1.0.0')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
CREATE FUNCTION public.hot_updater_v1_commit(p_commit jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  v_change jsonb;
  v_change_index integer := -1;
  v_expectation jsonb;
  v_expected double precision;
  v_actual double precision;
  v_found boolean;
  v_bundle public.hot_updater_v1_bundles;
  v_patch public.hot_updater_v1_bundle_patches;
  v_release public.hot_updater_v1_releases;
  v_catalog public.hot_updater_v1_release_catalogs;
  v_channel public.hot_updater_v1_channels;
  v_api_key public.hot_updater_v1_api_keys;
BEGIN
  IF pg_catalog.jsonb_typeof(p_commit) IS DISTINCT FROM 'object'
    OR pg_catalog.jsonb_typeof(p_commit->'changes') IS DISTINCT FROM 'array'
    OR (
      p_commit ? 'expectations'
      AND pg_catalog.jsonb_typeof(p_commit->'expectations') IS DISTINCT FROM 'array'
    )
  THEN
    RAISE EXCEPTION 'Hot Updater commit has an invalid envelope'
      USING ERRCODE = '22023';
  END IF;

  FOR v_expectation IN
    SELECT value
    FROM pg_catalog.jsonb_array_elements(
      COALESCE(p_commit->'expectations', '[]'::jsonb)
    ) AS expectation(value)
  LOOP
    IF v_expectation->>'model' = 'releases' THEN
      PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
          'hot_updater_v1:release:' || (v_expectation->>'id'),
          0
        )
      );
      SELECT release.revision::double precision
      INTO v_actual
      FROM public.hot_updater_v1_releases AS release
      WHERE release.id = (v_expectation->>'id')::uuid
      FOR UPDATE;
      v_found := FOUND;
      v_expected := (v_expectation->>'revision')::double precision;
    ELSIF v_expectation->>'model' = 'releaseCatalogs' THEN
      PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
          'hot_updater_v1:catalog:' || (v_expectation->>'scopeKey'),
          0
        )
      );
      SELECT catalog.generation
      INTO v_actual
      FROM public.hot_updater_v1_release_catalogs AS catalog
      WHERE catalog.scope_key = v_expectation->>'scopeKey'
      FOR UPDATE;
      v_found := FOUND;
      v_expected := (v_expectation->>'generation')::double precision;
    ELSE
      RAISE EXCEPTION 'Unsupported Hot Updater commit expectation'
        USING ERRCODE = '22023';
    END IF;

    IF (v_expected IS NULL AND v_found)
      OR (v_expected IS NOT NULL AND (NOT v_found OR v_actual <> v_expected))
    THEN
      RETURN pg_catalog.jsonb_build_object(
        'committed', false,
        'conflict', pg_catalog.jsonb_build_object(
          'changeIndex', -1,
          'reason', 'version_conflict',
          'model', v_expectation->>'model',
          'key', COALESCE(
            v_expectation->>'id',
            v_expectation->>'scopeKey'
          ),
          'expectedVersion', v_expected,
          'actualVersion', CASE WHEN v_found THEN v_actual ELSE NULL END
        )
      );
    END IF;
  END LOOP;

  BEGIN
    FOR v_change_index, v_change IN
      SELECT ordinal - 1, value
      FROM pg_catalog.jsonb_array_elements(p_commit->'changes')
        WITH ORDINALITY AS change(value, ordinal)
      ORDER BY ordinal
    LOOP
      CASE v_change->>'model'
        WHEN 'channels' THEN
          CASE v_change->>'operation'
            WHEN 'insert' THEN
              IF v_change->>'onConflict' <> 'ignore' THEN
                RAISE EXCEPTION 'Channel insert requires onConflict ignore'
                  USING ERRCODE = '22023';
              END IF;
              v_channel := pg_catalog.jsonb_populate_record(
                NULL::public.hot_updater_v1_channels,
                v_change->'row'
              );
              INSERT INTO public.hot_updater_v1_channels (id, name)
              VALUES (v_channel.id, v_channel.name)
              ON CONFLICT (name) DO NOTHING;
            WHEN 'delete' THEN
              BEGIN
                DELETE FROM public.hot_updater_v1_channels
                WHERE id = v_change->'where'->>'id';
                IF NOT FOUND THEN RAISE no_data_found; END IF;
              EXCEPTION
                WHEN foreign_key_violation THEN RAISE SQLSTATE 'HU001';
              END;
            ELSE
              RAISE EXCEPTION 'Unsupported Channel change'
                USING ERRCODE = '22023';
          END CASE;

        WHEN 'bundles' THEN
          CASE v_change->>'operation'
            WHEN 'insert' THEN
              v_bundle := pg_catalog.jsonb_populate_record(
                NULL::public.hot_updater_v1_bundles,
                v_change->'row'
              );
              INSERT INTO public.hot_updater_v1_bundles (
                id, platform, file_hash, git_commit_hash, storage_uri,
                archive_byte_size, metadata, manifest_storage_uri, manifest_file_hash,
                asset_base_storage_uri
              ) VALUES (
                v_bundle.id, v_bundle.platform, v_bundle.file_hash,
                v_bundle.git_commit_hash, v_bundle.storage_uri,
                v_bundle.archive_byte_size, v_bundle.metadata,
                v_bundle.manifest_storage_uri,
                v_bundle.manifest_file_hash, v_bundle.asset_base_storage_uri
              );
            WHEN 'update' THEN
              SELECT bundle.* INTO v_bundle
              FROM public.hot_updater_v1_bundles AS bundle
              WHERE bundle.id = (v_change->'where'->>'id')::uuid
              FOR UPDATE;
              IF NOT FOUND THEN RAISE no_data_found; END IF;
              v_bundle := pg_catalog.jsonb_populate_record(
                v_bundle,
                v_change->'update'
              );
              UPDATE public.hot_updater_v1_bundles SET
                platform = v_bundle.platform,
                file_hash = v_bundle.file_hash,
                git_commit_hash = v_bundle.git_commit_hash,
                storage_uri = v_bundle.storage_uri,
                archive_byte_size = v_bundle.archive_byte_size,
                metadata = v_bundle.metadata,
                manifest_storage_uri = v_bundle.manifest_storage_uri,
                manifest_file_hash = v_bundle.manifest_file_hash,
                asset_base_storage_uri = v_bundle.asset_base_storage_uri
              WHERE id = v_bundle.id;
            WHEN 'delete' THEN
              BEGIN
                DELETE FROM public.hot_updater_v1_bundles
                WHERE id = (v_change->'where'->>'id')::uuid;
                IF NOT FOUND THEN RAISE no_data_found; END IF;
              EXCEPTION
                WHEN foreign_key_violation THEN RAISE SQLSTATE 'HU001';
              END;
            ELSE
              RAISE EXCEPTION 'Unsupported Bundle change'
                USING ERRCODE = '22023';
          END CASE;

        WHEN 'bundlePatches' THEN
          CASE v_change->>'operation'
            WHEN 'insert' THEN
              v_patch := pg_catalog.jsonb_populate_record(
                NULL::public.hot_updater_v1_bundle_patches,
                v_change->'row'
              );
              INSERT INTO public.hot_updater_v1_bundle_patches (
                id, bundle_id, base_bundle_id, base_file_hash,
                patch_file_hash, patch_storage_uri, byte_size, order_index
              ) VALUES (
                v_patch.id, v_patch.bundle_id, v_patch.base_bundle_id,
                v_patch.base_file_hash, v_patch.patch_file_hash,
                v_patch.patch_storage_uri, v_patch.byte_size,
                v_patch.order_index
              );
            WHEN 'delete' THEN
              DELETE FROM public.hot_updater_v1_bundle_patches
              WHERE bundle_id = (v_change->'where'->>'bundleId')::uuid;
            ELSE
              RAISE EXCEPTION 'Unsupported Bundle patch change'
                USING ERRCODE = '22023';
          END CASE;

        WHEN 'releases' THEN
          CASE v_change->>'operation'
            WHEN 'insert' THEN
              v_release := pg_catalog.jsonb_populate_record(
                NULL::public.hot_updater_v1_releases,
                v_change->'row'
              );
              INSERT INTO public.hot_updater_v1_releases SELECT v_release.*;
            WHEN 'update' THEN
              SELECT release.* INTO v_release
              FROM public.hot_updater_v1_releases AS release
              WHERE release.id = (v_change->'where'->>'id')::uuid
              FOR UPDATE;
              IF NOT FOUND THEN RAISE no_data_found; END IF;
              v_release := pg_catalog.jsonb_populate_record(
                v_release,
                v_change->'update'
              );
              UPDATE public.hot_updater_v1_releases SET
                revision = v_release.revision,
                scope_key = v_release.scope_key,
                target_app_version = v_release.target_app_version,
                fingerprint_hash = v_release.fingerprint_hash,
                enabled = v_release.enabled,
                should_force_update = v_release.should_force_update,
                message = v_release.message,
                rollout_cohort_count = v_release.rollout_cohort_count,
                target_cohorts = v_release.target_cohorts,
                updated_at_ms = v_release.updated_at_ms
              WHERE id = v_release.id;
            WHEN 'delete' THEN
              DELETE FROM public.hot_updater_v1_releases
              WHERE id = (v_change->'where'->>'id')::uuid;
              IF NOT FOUND THEN RAISE no_data_found; END IF;
            ELSE
              RAISE EXCEPTION 'Unsupported Release change'
                USING ERRCODE = '22023';
          END CASE;

        WHEN 'releaseCatalogs' THEN
          IF v_change->>'operation' <> 'put' THEN
            RAISE EXCEPTION 'Unsupported Release catalog change'
              USING ERRCODE = '22023';
          END IF;
          v_catalog := pg_catalog.jsonb_populate_record(
            NULL::public.hot_updater_v1_release_catalogs,
            v_change->'row'
          );
          INSERT INTO public.hot_updater_v1_release_catalogs SELECT v_catalog.*
          ON CONFLICT (scope_key) DO UPDATE SET
            catalog_id = EXCLUDED.catalog_id,
            strategy = EXCLUDED.strategy,
            channel_id = EXCLUDED.channel_id,
            channel_key = EXCLUDED.channel_key,
            platform = EXCLUDED.platform,
            fingerprint_hash = EXCLUDED.fingerprint_hash,
            generation = EXCLUDED.generation,
            payload = EXCLUDED.payload,
            catalog_hash = EXCLUDED.catalog_hash,
            byte_size = EXCLUDED.byte_size,
            is_tombstone = EXCLUDED.is_tombstone,
            updated_at_ms = EXCLUDED.updated_at_ms;

        WHEN 'apiKeys' THEN
          CASE v_change->>'operation'
            WHEN 'insert' THEN
              IF v_change->>'onConflict' <> 'ignore' THEN
                RAISE EXCEPTION
                  'API key insert requires onConflict ignore'
                  USING ERRCODE = '22023';
              END IF;
              v_api_key := pg_catalog.jsonb_populate_record(
                NULL::public.hot_updater_v1_api_keys,
                v_change->'row'
              );
              INSERT INTO public.hot_updater_v1_api_keys (
                id, hash, name, prefix, role, created_at_ms, revoked_at_ms
              ) VALUES (
                v_api_key.id, v_api_key.hash, v_api_key.name,
                v_api_key.prefix, v_api_key.role,
                v_api_key.created_at_ms, v_api_key.revoked_at_ms
              ) ON CONFLICT (hash) DO NOTHING;
            WHEN 'update' THEN
              UPDATE public.hot_updater_v1_api_keys
              SET revoked_at_ms = (
                v_change->'update'->>'revokedAtMs'
              )::double precision
              WHERE id = v_change->'where'->>'id';
              IF NOT FOUND THEN RAISE no_data_found; END IF;
            ELSE
              RAISE EXCEPTION 'Unsupported API key change'
                USING ERRCODE = '22023';
          END CASE;

        ELSE
          RAISE EXCEPTION 'Unsupported commit model at index %', v_change_index
            USING ERRCODE = '22023';
      END CASE;
    END LOOP;
  EXCEPTION
    WHEN no_data_found THEN
      RETURN pg_catalog.jsonb_build_object(
        'committed', false,
        'conflict', pg_catalog.jsonb_build_object(
          'changeIndex', v_change_index,
          'reason', 'not_found'
        )
      );
    WHEN SQLSTATE 'HU001' THEN
      RETURN pg_catalog.jsonb_build_object(
        'committed', false,
        'conflict', pg_catalog.jsonb_build_object(
          'changeIndex', v_change_index,
          'reason', 'referenced'
        )
      );
  END;

  RETURN pg_catalog.jsonb_build_object('committed', true);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.hot_updater_v1_commit(jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hot_updater_v1_commit(jsonb)
  TO service_role;

CREATE FUNCTION public.hot_updater_v1_delete_channel(p_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  BEGIN
    DELETE FROM public.hot_updater_v1_channels
    WHERE id = p_id;

    IF NOT FOUND THEN
      RETURN pg_catalog.jsonb_build_object(
        'deleted', false,
        'reason', 'not_found'
      );
    END IF;
  EXCEPTION
    WHEN foreign_key_violation THEN
      RETURN pg_catalog.jsonb_build_object(
        'deleted', false,
        'reason', 'not_empty'
      );
  END;

  RETURN pg_catalog.jsonb_build_object('deleted', true);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.hot_updater_v1_delete_channel(text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hot_updater_v1_delete_channel(text)
  TO service_role;

CREATE INDEX hot_updater_v1_bundle_events_latest_idx
  ON public.hot_updater_v1_bundle_events(install_id, received_at_ms, id);

CREATE TABLE public.hot_updater_v1_bundle_event_heads (
  install_id text COLLATE "C" PRIMARY KEY NOT NULL,
  id uuid NOT NULL,
  received_at_ms double precision NOT NULL,
  user_id text COLLATE "C",
  platform text COLLATE "C" NOT NULL,
  channel text COLLATE "C" NOT NULL,
  type text NOT NULL,
  from_bundle_id uuid,
  to_bundle_id uuid NOT NULL
);
CREATE TABLE public.hot_updater_v1_insights_install_states (
  install_id text COLLATE "C" PRIMARY KEY NOT NULL,
  revision double precision NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  state text NOT NULL
);
CREATE TABLE public.hot_updater_v1_insights_lifetime_markers (
  marker_key text COLLATE "C" PRIMARY KEY NOT NULL,
  release_key text COLLATE "C" NOT NULL,
  install_id text COLLATE "C" NOT NULL,
  metric text NOT NULL CHECK (metric IN ('downloaded', 'recovered'))
);
CREATE TABLE public.hot_updater_v1_insights_release_summaries (
  release_key text COLLATE "C" PRIMARY KEY NOT NULL,
  platform text COLLATE "C" NOT NULL,
  channel text COLLATE "C" NOT NULL,
  release_id uuid NOT NULL,
  active_installations double precision NOT NULL DEFAULT 0,
  pending_installations double precision NOT NULL DEFAULT 0,
  downloaded_installations double precision NOT NULL DEFAULT 0,
  recovered_installations double precision NOT NULL DEFAULT 0,
  CHECK (active_installations >= 0 AND pending_installations >= 0
    AND downloaded_installations >= 0 AND recovered_installations >= 0)
);
CREATE TABLE public.hot_updater_v1_insights_hourly_activity (
  bucket_key text COLLATE "C" PRIMARY KEY NOT NULL,
  release_key text COLLATE "C" NOT NULL,
  platform text COLLATE "C" NOT NULL,
  channel text COLLATE "C" NOT NULL,
  release_id uuid NOT NULL,
  hour_start_ms double precision NOT NULL CHECK (hour_start_ms >= 0),
  downloaded_reports double precision NOT NULL DEFAULT 0,
  applied_reports double precision NOT NULL DEFAULT 0,
  recovered_reports double precision NOT NULL DEFAULT 0,
  CHECK (downloaded_reports >= 0 AND applied_reports >= 0 AND recovered_reports >= 0)
);
CREATE INDEX hot_updater_v1_insights_hourly_release_hour_idx
  ON public.hot_updater_v1_insights_hourly_activity(release_key, hour_start_ms);
CREATE INDEX hot_updater_v1_bundle_event_heads_user_idx
  ON public.hot_updater_v1_bundle_event_heads(user_id, install_id);
CREATE INDEX hot_updater_v1_bundle_event_heads_scope_idx
  ON public.hot_updater_v1_bundle_event_heads(platform, channel, received_at_ms);
CREATE INDEX hot_updater_v1_bundle_event_heads_from_idx
  ON public.hot_updater_v1_bundle_event_heads(type, platform, channel, from_bundle_id, received_at_ms);
CREATE INDEX hot_updater_v1_bundle_event_heads_to_idx
  ON public.hot_updater_v1_bundle_event_heads(type, platform, channel, to_bundle_id, received_at_ms);
ALTER TABLE public.hot_updater_v1_bundle_event_heads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hot_updater_v1_insights_install_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hot_updater_v1_insights_lifetime_markers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hot_updater_v1_insights_release_summaries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hot_updater_v1_insights_hourly_activity ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.hot_updater_v1_bundle_event_heads FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.hot_updater_v1_bundle_event_heads TO service_role;
REVOKE ALL ON public.hot_updater_v1_insights_install_states,
  public.hot_updater_v1_insights_lifetime_markers,
  public.hot_updater_v1_insights_release_summaries,
  public.hot_updater_v1_insights_hourly_activity FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.hot_updater_v1_insights_install_states,
  public.hot_updater_v1_insights_lifetime_markers,
  public.hot_updater_v1_insights_release_summaries,
  public.hot_updater_v1_insights_hourly_activity TO service_role;

CREATE FUNCTION public.hot_updater_v1_record_event(p_event jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  INSERT INTO public.hot_updater_v1_bundle_events
  SELECT * FROM pg_catalog.jsonb_populate_record(NULL::public.hot_updater_v1_bundle_events, p_event)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.hot_updater_v1_bundle_event_heads (
    install_id, id, received_at_ms, user_id, platform, channel, type,
    from_bundle_id, to_bundle_id
  )
  SELECT install_id, id, received_at_ms, user_id, platform, channel, type,
    from_bundle_id, to_bundle_id
  FROM public.hot_updater_v1_bundle_events WHERE id = (p_event->>'id')::uuid
  ON CONFLICT (install_id) DO UPDATE SET
    id = excluded.id,
    received_at_ms = excluded.received_at_ms,
    user_id = excluded.user_id,
    platform = excluded.platform,
    channel = excluded.channel,
    type = excluded.type,
    from_bundle_id = excluded.from_bundle_id,
    to_bundle_id = excluded.to_bundle_id
  WHERE (excluded.received_at_ms, excluded.id) >
    (hot_updater_v1_bundle_event_heads.received_at_ms, hot_updater_v1_bundle_event_heads.id);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.hot_updater_v1_record_event(jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hot_updater_v1_record_event(jsonb)
  TO service_role;

CREATE FUNCTION public.hot_updater_v1_record_prepared_event(p_prepared jsonb)
RETURNS text
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  v_event public.hot_updater_v1_bundle_events;
  v_delta jsonb;
  v_lifetime jsonb;
  v_hourly jsonb;
  v_actual double precision;
  v_expected double precision;
BEGIN
  v_event := pg_catalog.jsonb_populate_record(
    NULL::public.hot_updater_v1_bundle_events,
    p_prepared->'event'
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('hot_updater_v1:insights:' || v_event.install_id, 0)
  );
  IF EXISTS (
    SELECT 1 FROM public.hot_updater_v1_bundle_events WHERE id = v_event.id
  ) THEN
    RETURN 'duplicate';
  END IF;
  SELECT revision INTO v_actual
  FROM public.hot_updater_v1_insights_install_states
  WHERE install_id = v_event.install_id FOR UPDATE;
  v_actual := COALESCE(v_actual, 0);
  v_expected := (p_prepared->>'expectedRevision')::double precision;
  IF v_actual <> v_expected THEN RETURN 'conflict'; END IF;
  v_lifetime := p_prepared->'firstLifetime';
  IF v_lifetime <> 'null'::jsonb AND EXISTS (
    SELECT 1 FROM public.hot_updater_v1_insights_lifetime_markers
    WHERE marker_key = v_lifetime->>'markerKey'
  ) THEN
    RETURN 'conflict';
  END IF;

  INSERT INTO public.hot_updater_v1_bundle_events SELECT v_event.*;
  INSERT INTO public.hot_updater_v1_bundle_event_heads (
    install_id, id, received_at_ms, user_id, platform, channel, type,
    from_bundle_id, to_bundle_id
  ) VALUES (
    v_event.install_id, v_event.id, v_event.received_at_ms, v_event.user_id,
    v_event.platform, v_event.channel, v_event.type, v_event.from_bundle_id,
    v_event.to_bundle_id
  ) ON CONFLICT (install_id) DO UPDATE SET
    id = excluded.id, received_at_ms = excluded.received_at_ms,
    user_id = excluded.user_id, platform = excluded.platform,
    channel = excluded.channel, type = excluded.type,
    from_bundle_id = excluded.from_bundle_id, to_bundle_id = excluded.to_bundle_id
  WHERE (excluded.received_at_ms, excluded.id) >
    (hot_updater_v1_bundle_event_heads.received_at_ms,
      hot_updater_v1_bundle_event_heads.id);
  INSERT INTO public.hot_updater_v1_insights_install_states (
    install_id, revision, state
  ) VALUES (v_event.install_id, v_actual + 1, p_prepared->>'nextState')
  ON CONFLICT (install_id) DO UPDATE SET
    revision = excluded.revision, state = excluded.state;

  FOR v_delta IN SELECT value FROM pg_catalog.jsonb_array_elements(
    p_prepared->'summaryDeltas'
  ) AS item(value) LOOP
    INSERT INTO public.hot_updater_v1_insights_release_summaries (
      release_key, platform, channel, release_id
    ) VALUES (
      v_delta->>'releaseKey', v_delta->'release'->>'platform',
      v_delta->'release'->>'channel', (v_delta->'release'->>'releaseId')::uuid
    ) ON CONFLICT (release_key) DO NOTHING;
    UPDATE public.hot_updater_v1_insights_release_summaries SET
      active_installations = active_installations + (v_delta->>'active')::double precision,
      pending_installations = pending_installations + (v_delta->>'pending')::double precision,
      downloaded_installations = downloaded_installations + (v_delta->>'downloaded')::double precision,
      recovered_installations = recovered_installations + (v_delta->>'recovered')::double precision
    WHERE release_key = v_delta->>'releaseKey';
  END LOOP;
  IF v_lifetime <> 'null'::jsonb THEN
    INSERT INTO public.hot_updater_v1_insights_lifetime_markers (
      marker_key, release_key, install_id, metric
    ) VALUES (
      v_lifetime->>'markerKey', v_lifetime->>'releaseKey',
      v_lifetime->>'installId', v_lifetime->>'metric'
    );
  END IF;
  v_hourly := p_prepared->'hourly';
  IF v_hourly <> 'null'::jsonb THEN
    INSERT INTO public.hot_updater_v1_insights_hourly_activity (
      bucket_key, release_key, platform, channel, release_id, hour_start_ms,
      downloaded_reports, applied_reports, recovered_reports
    ) VALUES (
      v_hourly->>'bucketKey', v_hourly->>'releaseKey',
      v_hourly->'release'->>'platform', v_hourly->'release'->>'channel',
      (v_hourly->'release'->>'releaseId')::uuid,
      (v_hourly->>'hourStartMs')::double precision,
      CASE WHEN v_hourly->>'metric' = 'downloaded' THEN 1 ELSE 0 END,
      CASE WHEN v_hourly->>'metric' = 'applied' THEN 1 ELSE 0 END,
      CASE WHEN v_hourly->>'metric' = 'recovered' THEN 1 ELSE 0 END
    ) ON CONFLICT (bucket_key) DO UPDATE SET
      downloaded_reports = hot_updater_v1_insights_hourly_activity.downloaded_reports + excluded.downloaded_reports,
      applied_reports = hot_updater_v1_insights_hourly_activity.applied_reports + excluded.applied_reports,
      recovered_reports = hot_updater_v1_insights_hourly_activity.recovered_reports + excluded.recovered_reports;
  END IF;
  RETURN 'committed';
END;
$$;
REVOKE EXECUTE ON FUNCTION public.hot_updater_v1_record_prepared_event(jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hot_updater_v1_record_prepared_event(jsonb)
  TO service_role;

CREATE FUNCTION public.hot_updater_v1_get_release_activity(
  p_release_keys text[],
  p_start double precision DEFAULT NULL,
  p_end double precision DEFAULT NULL
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
  SELECT pg_catalog.jsonb_build_object(
    'summaries', COALESCE((
      SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(summary))
      FROM public.hot_updater_v1_insights_release_summaries AS summary
      WHERE summary.release_key = ANY(p_release_keys)
    ), '[]'::jsonb),
    'hourly', CASE WHEN p_start IS NULL THEN '[]'::jsonb ELSE COALESCE((
      SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(hourly)
        ORDER BY hourly.release_key, hourly.hour_start_ms)
      FROM public.hot_updater_v1_insights_hourly_activity AS hourly
      WHERE hourly.release_key = ANY(p_release_keys)
        AND hourly.hour_start_ms >= p_start
        AND hourly.hour_start_ms < p_end
    ), '[]'::jsonb) END
  )
$$;
REVOKE EXECUTE ON FUNCTION public.hot_updater_v1_get_release_activity(
  text[], double precision, double precision
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hot_updater_v1_get_release_activity(
  text[], double precision, double precision
) TO service_role;
NOTIFY pgrst, 'reload schema';
