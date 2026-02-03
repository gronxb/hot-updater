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
    rollout_percentage INTEGER DEFAULT 100
      CHECK (rollout_percentage >= 0 AND rollout_percentage <= 100),
    target_device_ids TEXT
);

CREATE INDEX bundles_target_app_version_idx ON bundles(target_app_version);
CREATE INDEX bundles_fingerprint_hash_idx ON bundles(fingerprint_hash);
