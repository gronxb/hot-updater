ALTER TABLE bundles
ADD COLUMN manifest_storage_uri text;

ALTER TABLE bundles
ADD COLUMN manifest_file_hash text;

ALTER TABLE bundles
ADD COLUMN asset_base_storage_uri text;

CREATE TABLE IF NOT EXISTS bundle_patches (
  id varchar(255) PRIMARY KEY NOT NULL,
  bundle_id uuid NOT NULL,
  base_bundle_id uuid NOT NULL,
  base_file_hash text NOT NULL,
  patch_file_hash text NOT NULL,
  patch_storage_uri text NOT NULL,
  order_index integer NOT NULL DEFAULT 0
);

CREATE INDEX bundle_patches_bundle_id_idx ON bundle_patches (bundle_id);

CREATE INDEX bundle_patches_base_bundle_id_idx ON bundle_patches (base_bundle_id);

ALTER TABLE bundle_patches
ADD CONSTRAINT bundle_patches_bundle_id_fk FOREIGN key (bundle_id) REFERENCES bundles (id) ON UPDATE RESTRICT ON DELETE CASCADE;

ALTER TABLE bundle_patches
ADD CONSTRAINT bundle_patches_base_bundle_id_fk FOREIGN key (base_bundle_id) REFERENCES bundles (id) ON UPDATE RESTRICT ON DELETE CASCADE;

INSERT INTO
  private_hot_updater_settings (key, value)
VALUES
  ('version', '0.31.0')
ON CONFLICT (key) DO UPDATE
SET
  value = '0.31.0';