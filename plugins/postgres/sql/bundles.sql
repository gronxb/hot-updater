-- HotUpdater.bundles

CREATE TYPE platforms AS ENUM ('ios', 'android');

CREATE TABLE bundles (
    id uuid PRIMARY KEY,
    platform platforms NOT NULL,
    should_force_update boolean NOT NULL,
    enabled boolean NOT NULL,
    file_hash text NOT NULL,
    git_commit_hash text,
    message text,
    channel text NOT NULL DEFAULT 'production',
    storage_uri text NOT NULL,
    target_app_version text,
    fingerprint_hash text,
    CONSTRAINT check_version_or_fingerprint CHECK (
        (target_app_version IS NOT NULL) OR (fingerprint_hash IS NOT NULL)
    )
);

CREATE INDEX bundles_target_app_version_idx ON bundles(target_app_version);
CREATE INDEX bundles_fingerprint_hash_idx ON bundles(fingerprint_hash);
CREATE INDEX bundles_channel_idx ON bundles(channel);