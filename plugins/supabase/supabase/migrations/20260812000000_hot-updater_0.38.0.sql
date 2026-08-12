-- HotUpdater.channels_0_38_0

CREATE TABLE IF NOT EXISTS public.channels (
  id uuid PRIMARY KEY NOT NULL,
  name text NOT NULL UNIQUE
);

ALTER TABLE public.bundles
  ADD COLUMN IF NOT EXISTS channel_id uuid;

INSERT INTO public.channels (id, name)
SELECT pg_catalog.gen_random_uuid(), legacy.channel
FROM (
  SELECT DISTINCT bundle.channel
  FROM public.bundles AS bundle
) AS legacy
ON CONFLICT (name) DO NOTHING;

UPDATE public.bundles AS bundle
SET channel_id = channel.id
FROM public.channels AS channel
WHERE bundle.channel_id IS NULL
  AND channel.name = bundle.channel;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.bundles AS bundle
    LEFT JOIN public.channels AS channel
      ON channel.id = bundle.channel_id
     AND channel.name = bundle.channel
    WHERE channel.id IS NULL
  ) THEN
    RAISE EXCEPTION
      'Hot Updater channel backfill left an unresolved bundle';
  END IF;
END;
$$;

ALTER TABLE public.bundles
  ALTER COLUMN channel_id SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conname = 'bundles_channel_id_fkey'
      AND conrelid = 'public.bundles'::pg_catalog.regclass
  ) THEN
    ALTER TABLE public.bundles
      ADD CONSTRAINT bundles_channel_id_fkey
      FOREIGN KEY (channel_id)
      REFERENCES public.channels(id);
  END IF;
END;
$$;

ALTER TABLE public.channels ENABLE ROW LEVEL SECURITY;

DROP FUNCTION IF EXISTS public.get_channels();
DROP FUNCTION IF EXISTS public.hot_updater_create_bundle_with_patches(
  jsonb,
  jsonb
);
DROP FUNCTION IF EXISTS public.hot_updater_update_bundle_with_patches(
  uuid,
  jsonb,
  jsonb
);
DROP FUNCTION IF EXISTS public.hot_updater_commit(jsonb);

CREATE FUNCTION public.hot_updater_delete_channel(p_id uuid)
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

CREATE FUNCTION public.hot_updater_commit(p_commit jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  v_change jsonb;
  v_change_index integer;
  v_bundle public.bundles;
  v_patch public.bundle_patches;
  v_channel public.channels;
  v_event public.bundle_events;
  v_access_key public.client_access_keys;
BEGIN
  IF pg_catalog.jsonb_typeof(p_commit) IS DISTINCT FROM 'object'
    OR pg_catalog.jsonb_typeof(p_commit->'changes') IS DISTINCT FROM 'array'
  THEN
    RAISE EXCEPTION 'Hot Updater commit must contain a changes array'
      USING ERRCODE = '22023';
  END IF;

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
                RAISE EXCEPTION
                  'channels inserts require onConflict ignore'
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
                WHERE id = (v_change->'where'->>'id')::uuid;
              EXCEPTION
                WHEN foreign_key_violation THEN
                  RAISE SQLSTATE 'HU001';
              END;

            ELSE
              RAISE EXCEPTION 'Unsupported channels commit change at index %',
                v_change_index
                USING ERRCODE = '22023';
          END CASE;

        WHEN 'bundles' THEN
          CASE v_change->>'operation'
            WHEN 'insert' THEN
              v_bundle := pg_catalog.jsonb_populate_record(
                NULL::public.bundles,
                v_change->'row'
              );
              IF NOT EXISTS (
                SELECT 1
                FROM public.channels AS channel
                WHERE channel.id = v_bundle.channel_id
                  AND channel.name = v_bundle.channel
              ) THEN
                RAISE EXCEPTION
                  'Bundle channel_id and channel do not reference one Channel'
                  USING ERRCODE = '23514';
              END IF;

              INSERT INTO public.bundles (
                id,
                platform,
                target_app_version,
                should_force_update,
                enabled,
                file_hash,
                git_commit_hash,
                message,
                channel,
                fingerprint_hash,
                metadata,
                storage_uri,
                rollout_cohort_count,
                target_cohorts,
                manifest_storage_uri,
                manifest_file_hash,
                asset_base_storage_uri,
                channel_id
              ) VALUES (
                v_bundle.id,
                v_bundle.platform,
                v_bundle.target_app_version,
                v_bundle.should_force_update,
                v_bundle.enabled,
                v_bundle.file_hash,
                v_bundle.git_commit_hash,
                v_bundle.message,
                v_bundle.channel,
                v_bundle.fingerprint_hash,
                v_bundle.metadata,
                v_bundle.storage_uri,
                v_bundle.rollout_cohort_count,
                v_bundle.target_cohorts,
                v_bundle.manifest_storage_uri,
                v_bundle.manifest_file_hash,
                v_bundle.asset_base_storage_uri,
                v_bundle.channel_id
              );

            WHEN 'update' THEN
              SELECT bundle.*
              INTO v_bundle
              FROM public.bundles AS bundle
              WHERE bundle.id = (v_change->'where'->>'id')::uuid
              FOR UPDATE;
              IF NOT FOUND THEN
                RAISE no_data_found;
              END IF;

              v_bundle := pg_catalog.jsonb_populate_record(
                v_bundle,
                v_change->'update'
              );
              IF NOT EXISTS (
                SELECT 1
                FROM public.channels AS channel
                WHERE channel.id = v_bundle.channel_id
                  AND channel.name = v_bundle.channel
              ) THEN
                RAISE EXCEPTION
                  'Bundle channel_id and channel do not reference one Channel'
                  USING ERRCODE = '23514';
              END IF;

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
                asset_base_storage_uri = v_bundle.asset_base_storage_uri,
                channel_id = v_bundle.channel_id
              WHERE id = (v_change->'where'->>'id')::uuid;

            WHEN 'delete' THEN
              DELETE FROM public.bundles
              WHERE id = (v_change->'where'->>'id')::uuid;

            ELSE
              RAISE EXCEPTION 'Unsupported bundles commit change at index %',
                v_change_index
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
                id,
                bundle_id,
                base_bundle_id,
                base_file_hash,
                patch_file_hash,
                patch_storage_uri,
                order_index
              ) VALUES (
                v_patch.id,
                v_patch.bundle_id,
                v_patch.base_bundle_id,
                v_patch.base_file_hash,
                v_patch.patch_file_hash,
                v_patch.patch_storage_uri,
                v_patch.order_index
              );

            WHEN 'delete' THEN
              DELETE FROM public.bundle_patches
              WHERE bundle_id = (v_change->'where'->>'bundleId')::uuid;

            ELSE
              RAISE EXCEPTION
                'Unsupported bundlePatches commit change at index %',
                v_change_index
                USING ERRCODE = '22023';
          END CASE;

        WHEN 'analytics' THEN
          IF v_change->>'operation' <> 'insert' THEN
            RAISE EXCEPTION 'Unsupported analytics commit change at index %',
              v_change_index
              USING ERRCODE = '22023';
          END IF;

          v_event := pg_catalog.jsonb_populate_record(
            NULL::public.bundle_events,
            v_change->'row'
          );
          INSERT INTO public.bundle_events (
            id,
            type,
            install_id,
            user_id,
            username,
            from_bundle_id,
            to_bundle_id,
            platform,
            app_version,
            channel,
            cohort,
            update_strategy,
            fingerprint_hash,
            sdk_version,
            received_at_ms
          ) VALUES (
            v_event.id,
            v_event.type,
            v_event.install_id,
            v_event.user_id,
            v_event.username,
            v_event.from_bundle_id,
            v_event.to_bundle_id,
            v_event.platform,
            v_event.app_version,
            v_event.channel,
            v_event.cohort,
            v_event.update_strategy,
            v_event.fingerprint_hash,
            v_event.sdk_version,
            v_event.received_at_ms
          );

        WHEN 'clientAccessKeys' THEN
          CASE v_change->>'operation'
            WHEN 'insert' THEN
              IF v_change->>'onConflict' <> 'ignore' THEN
                RAISE EXCEPTION
                  'clientAccessKeys inserts require onConflict ignore'
                  USING ERRCODE = '22023';
              END IF;
              v_access_key := pg_catalog.jsonb_populate_record(
                NULL::public.client_access_keys,
                v_change->'row'
              );
              INSERT INTO public.client_access_keys (
                id,
                hash,
                name,
                prefix,
                role,
                created_at_ms,
                revoked_at_ms
              ) VALUES (
                v_access_key.id,
                v_access_key.hash,
                v_access_key.name,
                v_access_key.prefix,
                v_access_key.role,
                v_access_key.created_at_ms,
                v_access_key.revoked_at_ms
              )
              ON CONFLICT (hash) DO NOTHING;

            WHEN 'update' THEN
              UPDATE public.client_access_keys
              SET revoked_at_ms = (
                v_change->'update'->>'revokedAtMs'
              )::double precision
              WHERE id = v_change->'where'->>'id';
              IF NOT FOUND THEN
                RAISE no_data_found;
              END IF;

            ELSE
              RAISE EXCEPTION
                'Unsupported clientAccessKeys commit change at index %',
                v_change_index
                USING ERRCODE = '22023';
          END CASE;

        ELSE
          RAISE EXCEPTION 'Unsupported commit model at index %',
            v_change_index
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
REVOKE EXECUTE ON FUNCTION public.hot_updater_delete_channel(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hot_updater_delete_channel(uuid)
  TO service_role;
