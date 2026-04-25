-- HotUpdater.bundles

CREATE TABLE bundles (
    id TEXT PRIMARY KEY,
    platform TEXT NOT NULL CHECK (platform IN ('ios', 'android')),
    target_app_version TEXT,
    should_force_update INTEGER NOT NULL CHECK (should_force_update IN (0, 1)),
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    file_hash TEXT NOT NULL,
    git_commit_hash TEXT,
    message TEXT,
    channel TEXT NOT NULL,
    storage_uri TEXT,
    fingerprint_hash TEXT,
    metadata JSONB DEFAULT '{}',
    manifest_storage_uri TEXT,
    manifest_file_hash TEXT,
    asset_base_storage_uri TEXT,
    patch_base_bundle_id TEXT,
    patch_base_file_hash TEXT,
    patch_file_hash TEXT,
    patch_storage_uri TEXT,
    rollout_cohort_count INTEGER DEFAULT 1000
      CHECK (rollout_cohort_count >= 0 AND rollout_cohort_count <= 1000),
    target_cohorts TEXT
);

CREATE INDEX bundles_target_app_version_idx ON bundles(target_app_version);
CREATE INDEX bundles_fingerprint_hash_idx ON bundles(fingerprint_hash);
CREATE INDEX bundles_patch_base_bundle_id_idx ON bundles(patch_base_bundle_id);
