-- HotUpdater.bundle_artifact_columns

ALTER TABLE bundles ADD COLUMN IF NOT EXISTS manifest_storage_uri text;
ALTER TABLE bundles ADD COLUMN IF NOT EXISTS manifest_file_hash text;
ALTER TABLE bundles ADD COLUMN IF NOT EXISTS asset_base_storage_uri text;

CREATE TABLE IF NOT EXISTS bundle_patches (
    id text PRIMARY KEY,
    bundle_id uuid NOT NULL REFERENCES bundles(id) ON DELETE CASCADE,
    base_bundle_id uuid NOT NULL REFERENCES bundles(id) ON DELETE CASCADE,
    base_file_hash text NOT NULL,
    patch_file_hash text NOT NULL,
    patch_storage_uri text NOT NULL,
    order_index integer NOT NULL DEFAULT 0
);

UPDATE bundles
SET
    manifest_storage_uri = COALESCE(manifest_storage_uri, metadata->>'manifest_storage_uri'),
    manifest_file_hash = COALESCE(manifest_file_hash, metadata->>'manifest_file_hash'),
    asset_base_storage_uri = COALESCE(asset_base_storage_uri, metadata->>'asset_base_storage_uri')
WHERE metadata IS NOT NULL;

INSERT INTO bundle_patches (
    id,
    bundle_id,
    base_bundle_id,
    base_file_hash,
    patch_file_hash,
    patch_storage_uri,
    order_index
)
SELECT
    id::text || ':' || base_bundle_id::text,
    id,
    base_bundle_id,
    metadata->>'hbc_patch_base_file_hash',
    metadata->>'hbc_patch_file_hash',
    metadata->>'hbc_patch_storage_uri',
    0
FROM (
    SELECT
        id,
        metadata,
        CASE
            WHEN metadata->>'patch_base_bundle_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                THEN (metadata->>'patch_base_bundle_id')::uuid
            WHEN metadata->>'diff_base_bundle_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                THEN (metadata->>'diff_base_bundle_id')::uuid
            ELSE NULL
        END AS base_bundle_id
    FROM bundles
    WHERE metadata IS NOT NULL
) bundle_patch_source
WHERE base_bundle_id IS NOT NULL
  AND metadata->>'hbc_patch_base_file_hash' IS NOT NULL
  AND metadata->>'hbc_patch_file_hash' IS NOT NULL
  AND metadata->>'hbc_patch_storage_uri' IS NOT NULL
ON CONFLICT (id) DO NOTHING;

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
    - 'patches'
WHERE metadata IS NOT NULL;

CREATE INDEX IF NOT EXISTS bundle_patches_bundle_id_idx
    ON bundle_patches(bundle_id);
CREATE INDEX IF NOT EXISTS bundle_patches_base_bundle_id_idx
    ON bundle_patches(base_bundle_id);
