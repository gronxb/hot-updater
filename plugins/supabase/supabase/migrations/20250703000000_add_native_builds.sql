-- Native builds table
-- The id field serves as the minBundleId identifier
CREATE TABLE native_builds (
    id uuid PRIMARY KEY,
    native_version text NOT NULL,
    platform platforms NOT NULL,
    fingerprint_hash text NOT NULL,
    storage_uri text NOT NULL,
    file_hash text NOT NULL,
    file_size bigint NOT NULL,
    channel text NOT NULL,
    metadata jsonb
);

-- Indexes for performance
CREATE INDEX native_builds_platform_idx ON native_builds(platform);
CREATE INDEX native_builds_channel_idx ON native_builds(channel);
CREATE INDEX native_builds_native_version_idx ON native_builds(native_version);
CREATE INDEX native_builds_fingerprint_hash_idx ON native_builds(fingerprint_hash);
CREATE INDEX native_builds_created_at_idx ON native_builds(created_at);