-- Native builds table
-- The id field serves as the minBundleId identifier
CREATE TABLE native_builds (
    id TEXT PRIMARY KEY,
    native_version TEXT NOT NULL,
    platform TEXT NOT NULL,
    fingerprint_hash TEXT NOT NULL,
    storage_uri TEXT NOT NULL,
    file_hash TEXT NOT NULL,
    file_size INTEGER NOT NULL,
    channel TEXT NOT NULL,
    metadata TEXT
);

-- Indexes for performance
CREATE INDEX native_builds_platform_idx ON native_builds(platform);
CREATE INDEX native_builds_channel_idx ON native_builds(channel);
CREATE INDEX native_builds_native_version_idx ON native_builds(native_version);
CREATE INDEX native_builds_fingerprint_hash_idx ON native_builds(fingerprint_hash);