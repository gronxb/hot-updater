-- Keep generic Channel deletion idempotent, including within larger atomic commits.
-- Table layouts and schema.core remain 1.0.0. Existing data and RPC permissions are preserved.
CREATE OR REPLACE FUNCTION public.hot_updater_v1_commit(p_commit jsonb)
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
                id, platform, git_commit_hash, metadata, manifest_storage_uri, manifest_file_hash,
                asset_base_storage_uri
              ) VALUES (
                v_bundle.id, v_bundle.platform, v_bundle.git_commit_hash,
                v_bundle.metadata,
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
                git_commit_hash = v_bundle.git_commit_hash,
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
