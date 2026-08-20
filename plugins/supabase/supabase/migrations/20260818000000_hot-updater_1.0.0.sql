-- HotUpdater.schema

CREATE TABLE public.channels (
  id text COLLATE "C" PRIMARY KEY NOT NULL
    CHECK (pg_catalog.char_length(id) BETWEEN 1 AND 255),
  name text COLLATE "C" NOT NULL UNIQUE
    CHECK (pg_catalog.char_length(name) BETWEEN 1 AND 255)
);

CREATE TABLE public.bundles (
  id uuid PRIMARY KEY NOT NULL,
  platform text NOT NULL,
  file_hash text NOT NULL,
  git_commit_hash text,
  storage_uri text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  manifest_storage_uri text,
  manifest_file_hash text,
  asset_base_storage_uri text
);

CREATE TABLE public.bundle_patches (
  id varchar(255) PRIMARY KEY NOT NULL,
  bundle_id uuid NOT NULL,
  base_bundle_id uuid NOT NULL,
  base_file_hash text NOT NULL,
  patch_file_hash text NOT NULL,
  patch_storage_uri text NOT NULL,
  order_index integer NOT NULL DEFAULT 0,
  CONSTRAINT bundle_patches_bundle_id_fk FOREIGN KEY (bundle_id)
    REFERENCES public.bundles(id) ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT bundle_patches_base_bundle_id_fk FOREIGN KEY (base_bundle_id)
    REFERENCES public.bundles(id) ON UPDATE RESTRICT ON DELETE CASCADE
);

CREATE TABLE public.releases (
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
  CONSTRAINT releases_strategy_target_check CHECK (
    (strategy = 'APP_VERSION' AND target_app_version IS NOT NULL AND fingerprint_hash IS NULL)
    OR (strategy = 'FINGERPRINT' AND target_app_version IS NULL AND fingerprint_hash IS NOT NULL)
  ),
  CONSTRAINT releases_channel_id_fk FOREIGN KEY (channel_id)
    REFERENCES public.channels(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT releases_bundle_id_fk FOREIGN KEY (bundle_id)
    REFERENCES public.bundles(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT releases_source_release_id_fk FOREIGN KEY (source_release_id)
    REFERENCES public.releases(id) ON UPDATE RESTRICT ON DELETE SET NULL
);

CREATE TABLE public.release_catalogs (
  scope_key varchar(2048) COLLATE "C" PRIMARY KEY NOT NULL,
  authority_id varchar(255) COLLATE "C" NOT NULL,
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
  CONSTRAINT release_catalogs_strategy_target_check CHECK (
    (strategy = 'APP_VERSION' AND fingerprint_hash IS NULL)
    OR (strategy = 'FINGERPRINT' AND fingerprint_hash IS NOT NULL)
  ),
  CONSTRAINT release_catalogs_channel_id_fk FOREIGN KEY (channel_id)
    REFERENCES public.channels(id) ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE TABLE public.bundle_events (
  id uuid PRIMARY KEY NOT NULL,
  type text NOT NULL,
  install_id text NOT NULL,
  user_id text,
  username text,
  from_release_id uuid,
  from_bundle_id uuid,
  to_release_id uuid,
  to_bundle_id uuid NOT NULL,
  platform text NOT NULL,
  app_version text NOT NULL,
  channel text NOT NULL,
  cohort text NOT NULL,
  update_strategy text,
  fingerprint_hash text,
  sdk_version text,
  received_at_ms double precision NOT NULL,
  CONSTRAINT bundle_events_type_check CHECK (
    type IN ('UPDATE_APPLIED', 'RECOVERED', 'RELEASE_ADOPTED', 'UNCHANGED')
  ),
  CONSTRAINT bundle_events_platform_check CHECK (
    platform IN ('ios', 'android')
  ),
  CONSTRAINT bundle_events_shape_check CHECK (
    (type IN ('UPDATE_APPLIED', 'RECOVERED', 'RELEASE_ADOPTED')
      AND from_bundle_id IS NOT NULL
      AND update_strategy IS NOT NULL
      AND update_strategy IN ('fingerprint', 'appVersion'))
    OR (type = 'UNCHANGED'
      AND from_bundle_id IS NULL
      AND update_strategy IS NULL)
  ),
  CONSTRAINT bundle_events_received_at_check CHECK (received_at_ms >= 0)
);

CREATE TABLE public.client_access_keys (
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

CREATE TABLE public.private_hot_updater_settings (
  key varchar(255) PRIMARY KEY NOT NULL,
  value text NOT NULL DEFAULT '1.0.0'
);

CREATE INDEX releases_scope_order_idx ON public.releases(scope_key, id);
CREATE INDEX releases_channel_platform_order_idx
  ON public.releases(channel_id, platform, id);
CREATE INDEX releases_bundle_id_idx ON public.releases(bundle_id);
CREATE INDEX releases_fingerprint_hash_idx ON public.releases(fingerprint_hash);
CREATE INDEX releases_enabled_idx ON public.releases(enabled);
CREATE INDEX release_catalogs_channel_idx ON public.release_catalogs(channel_id);
CREATE INDEX release_catalogs_authority_strategy_idx
  ON public.release_catalogs(authority_id, strategy);
CREATE INDEX bundle_patches_bundle_id_idx ON public.bundle_patches(bundle_id);
CREATE INDEX bundle_patches_base_bundle_id_idx
  ON public.bundle_patches(base_bundle_id);
CREATE INDEX bundle_events_received_at_idx
  ON public.bundle_events(received_at_ms, id);
CREATE INDEX bundle_events_install_idx
  ON public.bundle_events(install_id, received_at_ms, id);
CREATE INDEX bundle_events_user_id_idx
  ON public.bundle_events(user_id, received_at_ms, id);
CREATE INDEX bundle_events_username_idx
  ON public.bundle_events(username, received_at_ms, id);
CREATE INDEX bundle_events_to_bundle_idx
  ON public.bundle_events(type, to_bundle_id, received_at_ms, id);
CREATE INDEX bundle_events_from_bundle_idx
  ON public.bundle_events(type, from_bundle_id, received_at_ms, id);
CREATE INDEX bundle_events_to_release_idx
  ON public.bundle_events(type, to_release_id, received_at_ms, id);
CREATE INDEX bundle_events_from_release_idx
  ON public.bundle_events(type, from_release_id, received_at_ms, id);
CREATE UNIQUE INDEX client_access_keys_hash_key
  ON public.client_access_keys(hash);
CREATE INDEX client_access_keys_created_at_idx
  ON public.client_access_keys(created_at_ms, id);

ALTER TABLE public.channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bundles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bundle_patches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.releases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.release_catalogs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bundle_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.client_access_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.private_hot_updater_settings ENABLE ROW LEVEL SECURITY;

INSERT INTO public.private_hot_updater_settings (key, value)
VALUES ('schema.core', '1.0.0')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
CREATE FUNCTION public.hot_updater_commit(p_commit jsonb)
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
  v_bundle public.bundles;
  v_patch public.bundle_patches;
  v_release public.releases;
  v_catalog public.release_catalogs;
  v_channel public.channels;
  v_event public.bundle_events;
  v_access_key public.client_access_keys;
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
          'release:' || (v_expectation->>'id'),
          0
        )
      );
      SELECT release.revision::double precision
      INTO v_actual
      FROM public.releases AS release
      WHERE release.id = (v_expectation->>'id')::uuid
      FOR UPDATE;
      v_found := FOUND;
      v_expected := (v_expectation->>'revision')::double precision;
    ELSIF v_expectation->>'model' = 'releaseCatalogs' THEN
      PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
          'catalog:' || (v_expectation->>'scopeKey'),
          0
        )
      );
      SELECT catalog.generation
      INTO v_actual
      FROM public.release_catalogs AS catalog
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
                NULL::public.channels,
                v_change->'row'
              );
              INSERT INTO public.channels (id, name)
              VALUES (v_channel.id, v_channel.name)
              ON CONFLICT (name) DO NOTHING;
            WHEN 'delete' THEN
              BEGIN
                DELETE FROM public.channels
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
                NULL::public.bundles,
                v_change->'row'
              );
              INSERT INTO public.bundles (
                id, platform, file_hash, git_commit_hash, storage_uri,
                metadata, manifest_storage_uri, manifest_file_hash,
                asset_base_storage_uri
              ) VALUES (
                v_bundle.id, v_bundle.platform, v_bundle.file_hash,
                v_bundle.git_commit_hash, v_bundle.storage_uri,
                v_bundle.metadata, v_bundle.manifest_storage_uri,
                v_bundle.manifest_file_hash, v_bundle.asset_base_storage_uri
              );
            WHEN 'update' THEN
              SELECT bundle.* INTO v_bundle
              FROM public.bundles AS bundle
              WHERE bundle.id = (v_change->'where'->>'id')::uuid
              FOR UPDATE;
              IF NOT FOUND THEN RAISE no_data_found; END IF;
              v_bundle := pg_catalog.jsonb_populate_record(
                v_bundle,
                v_change->'update'
              );
              UPDATE public.bundles SET
                platform = v_bundle.platform,
                file_hash = v_bundle.file_hash,
                git_commit_hash = v_bundle.git_commit_hash,
                storage_uri = v_bundle.storage_uri,
                metadata = v_bundle.metadata,
                manifest_storage_uri = v_bundle.manifest_storage_uri,
                manifest_file_hash = v_bundle.manifest_file_hash,
                asset_base_storage_uri = v_bundle.asset_base_storage_uri
              WHERE id = v_bundle.id;
            WHEN 'delete' THEN
              BEGIN
                DELETE FROM public.bundles
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
                NULL::public.bundle_patches,
                v_change->'row'
              );
              INSERT INTO public.bundle_patches (
                id, bundle_id, base_bundle_id, base_file_hash,
                patch_file_hash, patch_storage_uri, order_index
              ) VALUES (
                v_patch.id, v_patch.bundle_id, v_patch.base_bundle_id,
                v_patch.base_file_hash, v_patch.patch_file_hash,
                v_patch.patch_storage_uri, v_patch.order_index
              );
            WHEN 'delete' THEN
              DELETE FROM public.bundle_patches
              WHERE bundle_id = (v_change->'where'->>'bundleId')::uuid;
            ELSE
              RAISE EXCEPTION 'Unsupported Bundle patch change'
                USING ERRCODE = '22023';
          END CASE;

        WHEN 'releases' THEN
          CASE v_change->>'operation'
            WHEN 'insert' THEN
              v_release := pg_catalog.jsonb_populate_record(
                NULL::public.releases,
                v_change->'row'
              );
              INSERT INTO public.releases SELECT v_release.*;
            WHEN 'update' THEN
              SELECT release.* INTO v_release
              FROM public.releases AS release
              WHERE release.id = (v_change->'where'->>'id')::uuid
              FOR UPDATE;
              IF NOT FOUND THEN RAISE no_data_found; END IF;
              v_release := pg_catalog.jsonb_populate_record(
                v_release,
                v_change->'update'
              );
              UPDATE public.releases SET
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
              DELETE FROM public.releases
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
            NULL::public.release_catalogs,
            v_change->'row'
          );
          INSERT INTO public.release_catalogs SELECT v_catalog.*
          ON CONFLICT (scope_key) DO UPDATE SET
            authority_id = EXCLUDED.authority_id,
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

        WHEN 'analytics' THEN
          IF v_change->>'operation' <> 'insert' THEN
            RAISE EXCEPTION 'Unsupported analytics change'
              USING ERRCODE = '22023';
          END IF;
          v_event := pg_catalog.jsonb_populate_record(
            NULL::public.bundle_events,
            v_change->'row'
          );
          INSERT INTO public.bundle_events (
            id, type, install_id, user_id, username, from_release_id,
            from_bundle_id, to_release_id, to_bundle_id, platform,
            app_version, channel, cohort, update_strategy, fingerprint_hash,
            sdk_version, received_at_ms
          ) VALUES (
            v_event.id, v_event.type, v_event.install_id, v_event.user_id,
            v_event.username, v_event.from_release_id, v_event.from_bundle_id,
            v_event.to_release_id, v_event.to_bundle_id, v_event.platform,
            v_event.app_version, v_event.channel, v_event.cohort,
            v_event.update_strategy, v_event.fingerprint_hash,
            v_event.sdk_version, v_event.received_at_ms
          );

        WHEN 'clientAccessKeys' THEN
          CASE v_change->>'operation'
            WHEN 'insert' THEN
              IF v_change->>'onConflict' <> 'ignore' THEN
                RAISE EXCEPTION
                  'Client access-key insert requires onConflict ignore'
                  USING ERRCODE = '22023';
              END IF;
              v_access_key := pg_catalog.jsonb_populate_record(
                NULL::public.client_access_keys,
                v_change->'row'
              );
              INSERT INTO public.client_access_keys (
                id, hash, name, prefix, role, created_at_ms, revoked_at_ms
              ) VALUES (
                v_access_key.id, v_access_key.hash, v_access_key.name,
                v_access_key.prefix, v_access_key.role,
                v_access_key.created_at_ms, v_access_key.revoked_at_ms
              ) ON CONFLICT (hash) DO NOTHING;
            WHEN 'update' THEN
              UPDATE public.client_access_keys
              SET revoked_at_ms = (
                v_change->'update'->>'revokedAtMs'
              )::double precision
              WHERE id = v_change->'where'->>'id';
              IF NOT FOUND THEN RAISE no_data_found; END IF;
            ELSE
              RAISE EXCEPTION 'Unsupported Client access-key change'
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

REVOKE EXECUTE ON FUNCTION public.hot_updater_commit(jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hot_updater_commit(jsonb)
  TO service_role;

CREATE FUNCTION public.hot_updater_delete_channel(p_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  BEGIN
    DELETE FROM public.channels
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

REVOKE EXECUTE ON FUNCTION public.hot_updater_delete_channel(text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hot_updater_delete_channel(text)
  TO service_role;
