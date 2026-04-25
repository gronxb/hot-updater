-- HotUpdater.bundle_artifact_columns

ALTER TABLE bundles ADD COLUMN IF NOT EXISTS manifest_storage_uri text;
ALTER TABLE bundles ADD COLUMN IF NOT EXISTS manifest_file_hash text;
ALTER TABLE bundles ADD COLUMN IF NOT EXISTS asset_base_storage_uri text;
ALTER TABLE bundles ADD COLUMN IF NOT EXISTS patch_base_bundle_id uuid;
ALTER TABLE bundles ADD COLUMN IF NOT EXISTS patch_base_file_hash text;
ALTER TABLE bundles ADD COLUMN IF NOT EXISTS patch_file_hash text;
ALTER TABLE bundles ADD COLUMN IF NOT EXISTS patch_storage_uri text;

UPDATE bundles
SET
    manifest_storage_uri = COALESCE(manifest_storage_uri, metadata->>'manifest_storage_uri'),
    manifest_file_hash = COALESCE(manifest_file_hash, metadata->>'manifest_file_hash'),
    asset_base_storage_uri = COALESCE(asset_base_storage_uri, metadata->>'asset_base_storage_uri'),
    patch_base_bundle_id = COALESCE(
        patch_base_bundle_id,
        CASE
            WHEN metadata->>'patch_base_bundle_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                THEN (metadata->>'patch_base_bundle_id')::uuid
            WHEN metadata->>'diff_base_bundle_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                THEN (metadata->>'diff_base_bundle_id')::uuid
            ELSE NULL
        END
    ),
    patch_base_file_hash = COALESCE(patch_base_file_hash, metadata->>'hbc_patch_base_file_hash'),
    patch_file_hash = COALESCE(patch_file_hash, metadata->>'hbc_patch_file_hash'),
    patch_storage_uri = COALESCE(patch_storage_uri, metadata->>'hbc_patch_storage_uri')
WHERE metadata IS NOT NULL;

UPDATE bundles
SET metadata = metadata
    - 'manifest_storage_uri'
    - 'manifest_file_hash'
    - 'asset_base_storage_uri'
    - 'patch_base_bundle_id'
    - 'diff_base_bundle_id'
    - 'hbc_patch_algorithm'
    - 'hbc_patch_asset_path'
    - 'hbc_patch_base_file_hash'
    - 'hbc_patch_file_hash'
    - 'hbc_patch_storage_uri'
WHERE metadata IS NOT NULL;

CREATE INDEX IF NOT EXISTS bundles_patch_base_bundle_id_idx
    ON bundles(patch_base_bundle_id);
