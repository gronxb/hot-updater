-- HotUpdater.bundles

CREATE TYPE platforms AS ENUM ('ios', 'android');

CREATE TABLE bundles (
    id uuid PRIMARY KEY,
    app_name text NOT NULL,
    platform platforms NOT NULL,
    target_app_version text NOT NULL,
    should_force_update boolean NOT NULL,
    enabled boolean NOT NULL,
    file_url text NOT NULL,
    file_hash text NOT NULL,
    git_commit_hash text,
    message text
);

CREATE INDEX bundles_target_app_version_idx ON bundles(target_app_version);
