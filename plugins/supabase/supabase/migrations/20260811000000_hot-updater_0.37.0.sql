CREATE TABLE public.bundle_events (
  id uuid PRIMARY KEY NOT NULL,
  type text NOT NULL CHECK (type IN ('UPDATE_APPLIED', 'RECOVERED', 'UNCHANGED')),
  install_id text NOT NULL,
  user_id text,
  username text,
  from_bundle_id uuid,
  to_bundle_id uuid NOT NULL,
  platform text NOT NULL CHECK (platform IN ('ios', 'android')),
  app_version text NOT NULL,
  channel text NOT NULL,
  cohort text NOT NULL,
  update_strategy text,
  fingerprint_hash text,
  sdk_version text,
  received_at_ms double precision NOT NULL CHECK (received_at_ms >= 0),
  CONSTRAINT bundle_events_shape_check CHECK (
    (
      type IN ('UPDATE_APPLIED', 'RECOVERED')
      AND from_bundle_id IS NOT NULL
      AND update_strategy IN ('fingerprint', 'appVersion')
    ) OR (
      type = 'UNCHANGED'
      AND from_bundle_id IS NULL
      AND update_strategy IS NULL
    )
  )
);

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

CREATE UNIQUE INDEX client_access_keys_hash_key
  ON public.client_access_keys(hash);
CREATE INDEX client_access_keys_created_at_idx
  ON public.client_access_keys(created_at_ms, id);

ALTER TABLE public.bundle_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.client_access_keys ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION public.hot_updater_commit(p_mutations jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  v_mutation jsonb;
  v_bundle_change jsonb;
  v_bundle public.bundles;
  v_bundle_id uuid;
  v_patches jsonb;
  v_has_patch_changes boolean;
BEGIN
  FOR v_mutation IN
    SELECT value FROM pg_catalog.jsonb_array_elements(p_mutations)
  LOOP
    IF v_mutation->>'operation' = 'update' THEN
      v_bundle_id := (v_mutation->>'bundleId')::uuid;
      PERFORM 1
      FROM public.bundles
      WHERE id = v_bundle_id
      FOR UPDATE;
      IF NOT FOUND THEN
        RETURN pg_catalog.jsonb_build_object(
          'applied', false,
          'missingBundleId', v_mutation->>'bundleId'
        );
      END IF;
    END IF;
  END LOOP;

  FOR v_mutation IN
    SELECT value FROM pg_catalog.jsonb_array_elements(p_mutations)
  LOOP
    v_bundle_id := (v_mutation->>'bundleId')::uuid;
    SELECT value
    INTO v_bundle_change
    FROM pg_catalog.jsonb_array_elements(v_mutation->'changes')
    WHERE value->>'table' = 'bundles'
    LIMIT 1;
    v_has_patch_changes := EXISTS (
      SELECT 1
      FROM pg_catalog.jsonb_array_elements(v_mutation->'changes')
      WHERE value->>'table' = 'bundle_patches'
    );
    SELECT COALESCE(
      pg_catalog.jsonb_agg(value->'row'),
      '[]'::jsonb
    )
    INTO v_patches
    FROM pg_catalog.jsonb_array_elements(v_mutation->'changes')
    WHERE value->>'table' = 'bundle_patches'
      AND value->>'operation' = 'insert';

    CASE v_mutation->>'operation'
      WHEN 'insert' THEN
        PERFORM public.hot_updater_create_bundle_with_patches(
          v_bundle_change->'row',
          v_patches
        );
      WHEN 'update' THEN
        IF v_has_patch_changes THEN
          PERFORM public.hot_updater_update_bundle_with_patches(
            v_bundle_id,
            COALESCE(v_bundle_change->'update', '{}'::jsonb),
            v_patches
          );
        ELSIF v_bundle_change IS NOT NULL THEN
          SELECT bundle.*
          INTO v_bundle
          FROM public.bundles AS bundle
          WHERE bundle.id = v_bundle_id;
          v_bundle := pg_catalog.jsonb_populate_record(
            v_bundle,
            v_bundle_change->'update'
          );
          UPDATE public.bundles SET
            platform = v_bundle.platform,
            target_app_version = v_bundle.target_app_version,
            should_force_update = v_bundle.should_force_update,
            enabled = v_bundle.enabled,
            file_hash = v_bundle.file_hash,
            git_commit_hash = v_bundle.git_commit_hash,
            message = v_bundle.message,
            channel = v_bundle.channel,
            fingerprint_hash = v_bundle.fingerprint_hash,
            metadata = v_bundle.metadata,
            storage_uri = v_bundle.storage_uri,
            rollout_cohort_count = v_bundle.rollout_cohort_count,
            target_cohorts = v_bundle.target_cohorts,
            manifest_storage_uri = v_bundle.manifest_storage_uri,
            manifest_file_hash = v_bundle.manifest_file_hash,
            asset_base_storage_uri = v_bundle.asset_base_storage_uri
          WHERE id = v_bundle_id;
        END IF;
      WHEN 'delete' THEN
        DELETE FROM public.bundles WHERE id = v_bundle_id;
    END CASE;
  END LOOP;

  RETURN pg_catalog.jsonb_build_object('applied', true);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.hot_updater_commit(jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hot_updater_commit(jsonb)
  TO service_role;
