CREATE TABLE channels (
    id TEXT PRIMARY KEY
);

INSERT INTO channels (id)
SELECT DISTINCT channel FROM bundles;

CREATE TABLE bundles_v2 (
    id TEXT PRIMARY KEY,
    platform TEXT NOT NULL CHECK (platform IN ('ios', 'android')),
    target_app_version TEXT,
    should_force_update INTEGER NOT NULL CHECK (should_force_update IN (0, 1)),
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    file_hash TEXT NOT NULL,
    git_commit_hash TEXT,
    message TEXT,
    channel TEXT NOT NULL DEFAULT 'production',
    storage_uri TEXT NOT NULL,
    fingerprint_hash TEXT,
    metadata JSONB DEFAULT '{}',
    manifest_storage_uri TEXT,
    manifest_file_hash TEXT,
    asset_base_storage_uri TEXT,
    rollout_cohort_count INTEGER DEFAULT 1000
      CHECK (rollout_cohort_count >= 0 AND rollout_cohort_count <= 1000),
    target_cohorts TEXT,
    FOREIGN KEY (channel) REFERENCES channels(id) ON DELETE RESTRICT,
    CHECK ((target_app_version IS NOT NULL) OR (fingerprint_hash IS NOT NULL))
);

INSERT INTO bundles_v2 (
    id,
    platform,
    should_force_update,
    enabled,
    file_hash,
    git_commit_hash,
    message,
    channel,
    storage_uri,
    target_app_version,
    fingerprint_hash,
    metadata,
    rollout_cohort_count,
    target_cohorts,
    manifest_storage_uri,
    manifest_file_hash,
    asset_base_storage_uri
)
SELECT
    id,
    platform,
    should_force_update,
    enabled,
    file_hash,
    git_commit_hash,
    message,
    channel,
    storage_uri,
    target_app_version,
    fingerprint_hash,
    metadata,
    rollout_cohort_count,
    target_cohorts,
    manifest_storage_uri,
    manifest_file_hash,
    asset_base_storage_uri
FROM bundles;

CREATE TABLE bundle_patches_v2 (
    id TEXT PRIMARY KEY,
    bundle_id TEXT NOT NULL,
    base_bundle_id TEXT NOT NULL,
    base_file_hash TEXT NOT NULL,
    patch_file_hash TEXT NOT NULL,
    patch_storage_uri TEXT NOT NULL,
    order_index INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (bundle_id) REFERENCES bundles_v2(id) ON DELETE CASCADE,
    FOREIGN KEY (base_bundle_id) REFERENCES bundles_v2(id) ON DELETE CASCADE
);

INSERT INTO bundle_patches_v2 (
    id,
    bundle_id,
    base_bundle_id,
    base_file_hash,
    patch_file_hash,
    patch_storage_uri,
    order_index
)
SELECT
    id,
    bundle_id,
    base_bundle_id,
    base_file_hash,
    patch_file_hash,
    patch_storage_uri,
    order_index
FROM bundle_patches;

DROP TABLE bundle_patches;
DROP TABLE bundles;
ALTER TABLE bundles_v2 RENAME TO bundles;
ALTER TABLE bundle_patches_v2 RENAME TO bundle_patches;

CREATE INDEX bundles_target_app_version_idx ON bundles(target_app_version);
CREATE INDEX bundles_fingerprint_hash_idx ON bundles(fingerprint_hash);
CREATE INDEX bundles_channel_idx ON bundles(channel);
CREATE INDEX bundles_rollout_idx ON bundles(rollout_cohort_count);
CREATE INDEX bundle_patches_bundle_id_idx ON bundle_patches(bundle_id);
CREATE INDEX bundle_patches_base_bundle_id_idx ON bundle_patches(base_bundle_id);
