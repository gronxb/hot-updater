-- Migration number: 0001 	 2025-01-27T08:37:50.374Z
-- HotUpdater.bundles

CREATE TABLE bundles (
    id TEXT PRIMARY KEY,
    platform TEXT NOT NULL CHECK (platform IN ('ios', 'android')),
    target_app_version TEXT NOT NULL,
    should_force_update INTEGER NOT NULL CHECK (should_force_update IN (0, 1)),
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    file_url TEXT NOT NULL,
    file_hash TEXT NOT NULL,
    git_commit_hash TEXT,
    message TEXT
);

CREATE INDEX bundles_target_app_version_idx ON bundles(target_app_version);
