CREATE TYPE platforms AS ENUM ('ios', 'android');

CREATE TABLE bundles (
    id uuid PRIMARY KEY,
    platform platforms NOT NULL,
    target_version text NOT NULL,
    force_update boolean NOT NULL,
    enabled boolean NOT NULL,
    file_url text NOT NULL,
    file_hash text NOT NULL,
    git_commit_hash text,
    message text
);
