-- Migration number: 0005 	 2026-04-22T00:00:00.000Z

-- HotUpdater.bundle_artifact_columns

ALTER TABLE bundles ADD COLUMN manifest_storage_uri TEXT;
ALTER TABLE bundles ADD COLUMN manifest_file_hash TEXT;
ALTER TABLE bundles ADD COLUMN asset_base_storage_uri TEXT;
ALTER TABLE bundles ADD COLUMN patch_base_bundle_id TEXT;
ALTER TABLE bundles ADD COLUMN patch_base_file_hash TEXT;
ALTER TABLE bundles ADD COLUMN patch_file_hash TEXT;
ALTER TABLE bundles ADD COLUMN patch_storage_uri TEXT;

UPDATE bundles
SET
    manifest_storage_uri = COALESCE(
        manifest_storage_uri,
        json_extract(metadata, '$.manifest_storage_uri')
    ),
    manifest_file_hash = COALESCE(
        manifest_file_hash,
        json_extract(metadata, '$.manifest_file_hash')
    ),
    asset_base_storage_uri = COALESCE(
        asset_base_storage_uri,
        json_extract(metadata, '$.asset_base_storage_uri')
    ),
    patch_base_bundle_id = COALESCE(
        patch_base_bundle_id,
        json_extract(metadata, '$.patch_base_bundle_id'),
        json_extract(metadata, '$.diff_base_bundle_id')
    ),
    patch_base_file_hash = COALESCE(
        patch_base_file_hash,
        json_extract(metadata, '$.hbc_patch_base_file_hash')
    ),
    patch_file_hash = COALESCE(
        patch_file_hash,
        json_extract(metadata, '$.hbc_patch_file_hash')
    ),
    patch_storage_uri = COALESCE(
        patch_storage_uri,
        json_extract(metadata, '$.hbc_patch_storage_uri')
    )
WHERE metadata IS NOT NULL;

UPDATE bundles
SET metadata = json_remove(
    metadata,
    '$.manifest_storage_uri',
    '$.manifest_file_hash',
    '$.asset_base_storage_uri',
    '$.patch_base_bundle_id',
    '$.diff_base_bundle_id',
    '$.hbc_patch_algorithm',
    '$.hbc_patch_asset_path',
    '$.hbc_patch_base_file_hash',
    '$.hbc_patch_file_hash',
    '$.hbc_patch_storage_uri'
)
WHERE metadata IS NOT NULL;

CREATE INDEX IF NOT EXISTS bundles_patch_base_bundle_id_idx
    ON bundles(patch_base_bundle_id);
