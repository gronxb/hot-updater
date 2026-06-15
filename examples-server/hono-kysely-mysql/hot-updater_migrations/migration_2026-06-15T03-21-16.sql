ALTER TABLE bundles
ADD COLUMN manifest_storage_uri text;

ALTER TABLE bundles
ADD COLUMN manifest_file_hash text;

ALTER TABLE bundles
ADD COLUMN asset_base_storage_uri text;

CREATE TABLE IF NOT EXISTS bundle_patches (
  id varchar(255) PRIMARY KEY not NULL,
  bundle_id char(36) not NULL,
  base_bundle_id char(36) not NULL,
  base_file_hash text not NULL,
  patch_file_hash text not NULL,
  patch_storage_uri text not NULL,
  order_index integer not NULL default 0
);

CREATE INDEX bundle_patches_bundle_id_idx ON bundle_patches (bundle_id);

CREATE INDEX bundle_patches_base_bundle_id_idx ON bundle_patches (base_bundle_id);

ALTER TABLE bundle_patches
ADD CONSTRAINT bundle_patches_bundle_id_fk FOREIGN KEY (bundle_id) REFERENCES bundles (id) ON UPDATE RESTRICT ON DELETE CASCADE;

ALTER TABLE bundle_patches
ADD CONSTRAINT bundle_patches_base_bundle_id_fk FOREIGN KEY (base_bundle_id) REFERENCES bundles (id) ON UPDATE RESTRICT ON DELETE CASCADE;

INSERT INTO
  private_hot_updater_settings (`key`, value)
VALUES
  ('version', '0.31.0')
ON DUPLICATE KEY UPDATE
  value = '0.31.0';