-- Migration number: 0005 	 2026-04-22T00:00:00.000Z

-- HotUpdater.bundle_artifact_columns

ALTER TABLE bundles ADD COLUMN manifest_storage_uri TEXT;
ALTER TABLE bundles ADD COLUMN manifest_file_hash TEXT;
ALTER TABLE bundles ADD COLUMN asset_base_storage_uri TEXT;

CREATE TABLE bundle_patches (
    id TEXT PRIMARY KEY,
    bundle_id TEXT NOT NULL,
    base_bundle_id TEXT NOT NULL,
    base_file_hash TEXT NOT NULL,
    patch_file_hash TEXT NOT NULL,
    patch_storage_uri TEXT NOT NULL,
    order_index INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (bundle_id) REFERENCES bundles(id) ON DELETE CASCADE,
    FOREIGN KEY (base_bundle_id) REFERENCES bundles(id) ON DELETE CASCADE
);

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
    )
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
    id || ':' || COALESCE(
        json_extract(metadata, '$.patch_base_bundle_id'),
        json_extract(metadata, '$.diff_base_bundle_id')
    ),
    id,
    COALESCE(
        json_extract(metadata, '$.patch_base_bundle_id'),
        json_extract(metadata, '$.diff_base_bundle_id')
    ),
    json_extract(metadata, '$.hbc_patch_base_file_hash'),
    json_extract(metadata, '$.hbc_patch_file_hash'),
    json_extract(metadata, '$.hbc_patch_storage_uri'),
    0
FROM bundles
WHERE metadata IS NOT NULL
  AND COALESCE(
      json_extract(metadata, '$.patch_base_bundle_id'),
      json_extract(metadata, '$.diff_base_bundle_id')
  ) IS NOT NULL
  AND json_extract(metadata, '$.hbc_patch_base_file_hash') IS NOT NULL
  AND json_extract(metadata, '$.hbc_patch_file_hash') IS NOT NULL
  AND json_extract(metadata, '$.hbc_patch_storage_uri') IS NOT NULL;

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
    '$.hbc_patch_storage_uri',
    '$.patches'
)
WHERE metadata IS NOT NULL;

CREATE INDEX IF NOT EXISTS bundle_patches_bundle_id_idx
    ON bundle_patches(bundle_id);
CREATE INDEX IF NOT EXISTS bundle_patches_base_bundle_id_idx
    ON bundle_patches(base_bundle_id);
