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

CREATE INDEX IF NOT EXISTS bundle_patches_bundle_id_idx
    ON bundle_patches(bundle_id);
CREATE INDEX IF NOT EXISTS bundle_patches_base_bundle_id_idx
    ON bundle_patches(base_bundle_id);
