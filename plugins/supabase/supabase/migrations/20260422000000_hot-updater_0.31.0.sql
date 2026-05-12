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

CREATE INDEX IF NOT EXISTS bundle_patches_bundle_id_idx
    ON bundle_patches(bundle_id);
CREATE INDEX IF NOT EXISTS bundle_patches_base_bundle_id_idx
    ON bundle_patches(base_bundle_id);
