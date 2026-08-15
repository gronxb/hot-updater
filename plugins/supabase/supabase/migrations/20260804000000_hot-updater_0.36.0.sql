CREATE FUNCTION public.hot_updater_create_bundle_with_patches(
  p_bundle jsonb,
  p_patches jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  v_bundle public.bundles;
BEGIN
  v_bundle := pg_catalog.jsonb_populate_record(NULL::public.bundles, p_bundle);

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
    asset_base_storage_uri
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
    v_bundle.asset_base_storage_uri
  );

  INSERT INTO public.bundle_patches (
    id,
    bundle_id,
    base_bundle_id,
    base_file_hash,
    patch_file_hash,
    patch_storage_uri,
    order_index
  )
  SELECT
    v_bundle.id::text || ':' || patch.base_bundle_id::text,
    v_bundle.id,
    patch.base_bundle_id,
    patch.base_file_hash,
    patch.patch_file_hash,
    patch.patch_storage_uri,
    patch.order_index
  FROM pg_catalog.jsonb_to_recordset(p_patches) AS patch(
    base_bundle_id uuid,
    base_file_hash text,
    patch_file_hash text,
    patch_storage_uri text,
    order_index integer
  );
END;
$$;

CREATE FUNCTION public.hot_updater_update_bundle_with_patches(
  p_bundle_id uuid,
  p_update jsonb,
  p_patches jsonb
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  v_bundle public.bundles;
BEGIN
  SELECT bundle.*
  INTO v_bundle
  FROM public.bundles AS bundle
  WHERE bundle.id = p_bundle_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  v_bundle := pg_catalog.jsonb_populate_record(v_bundle, p_update);
  v_bundle.id := p_bundle_id;

  UPDATE public.bundles
  SET
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
  WHERE id = p_bundle_id;

  DELETE FROM public.bundle_patches
  WHERE bundle_id = p_bundle_id;

  INSERT INTO public.bundle_patches (
    id,
    bundle_id,
    base_bundle_id,
    base_file_hash,
    patch_file_hash,
    patch_storage_uri,
    order_index
  )
  SELECT
    p_bundle_id::text || ':' || patch.base_bundle_id::text,
    p_bundle_id,
    patch.base_bundle_id,
    patch.base_file_hash,
    patch.patch_file_hash,
    patch.patch_storage_uri,
    patch.order_index
  FROM pg_catalog.jsonb_to_recordset(p_patches) AS patch(
    base_bundle_id uuid,
    base_file_hash text,
    patch_file_hash text,
    patch_storage_uri text,
    order_index integer
  );

  RETURN true;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.hot_updater_create_bundle_with_patches(
  jsonb,
  jsonb
) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.hot_updater_update_bundle_with_patches(
  uuid,
  jsonb,
  jsonb
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.hot_updater_create_bundle_with_patches(
  jsonb,
  jsonb
) TO service_role;
GRANT EXECUTE ON FUNCTION public.hot_updater_update_bundle_with_patches(
  uuid,
  jsonb,
  jsonb
) TO service_role;
