-- Migration number: 0003 	 2025-05-18T16:25:12.486Z
-- HotUpdater.bundles

ALTER TABLE bundles ADD COLUMN fingerprint_hash TEXT;
ALTER TABLE bundles ADD COLUMN storage_uri TEXT;

UPDATE bundles
SET storage_uri = 'r2://%%BUCKET_NAME%%/' || id || '/bundle.zip'
WHERE storage_uri IS NULL;

CREATE TABLE bundles_temp (
    id TEXT PRIMARY KEY,
    platform TEXT NOT NULL,
    should_force_update INTEGER NOT NULL,
    enabled INTEGER NOT NULL,
    file_hash TEXT NOT NULL,
    git_commit_hash TEXT,
    message TEXT,
    channel TEXT NOT NULL DEFAULT 'production',
    storage_uri TEXT NOT NULL,
    target_app_version TEXT,
    fingerprint_hash TEXT,
    metadata JSONB DEFAULT '{}'::jsonb,
    CHECK ((target_app_version IS NOT NULL) OR (fingerprint_hash IS NOT NULL))
);

INSERT INTO bundles_temp 
SELECT id, platform, should_force_update, enabled, file_hash, git_commit_hash, message, channel, storage_uri, target_app_version, fingerprint_hash
FROM bundles;

DROP TABLE bundles;

ALTER TABLE bundles_temp RENAME TO bundles;

CREATE INDEX bundles_target_app_version_idx ON bundles(target_app_version);
CREATE INDEX bundles_fingerprint_hash_idx ON bundles(fingerprint_hash);
CREATE INDEX bundles_channel_idx ON bundles(channel);