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
    ),
    metadata jsonb DEFAULT '{}'::jsonb,
    manifest_storage_uri text,
    manifest_file_hash text,
    asset_base_storage_uri text,
    rollout_cohort_count INTEGER DEFAULT 1000
      CHECK (rollout_cohort_count >= 0 AND rollout_cohort_count <= 1000),
    target_cohorts TEXT[]
);

CREATE TABLE bundle_patches (
    id text PRIMARY KEY,
    bundle_id uuid NOT NULL REFERENCES bundles(id) ON DELETE CASCADE,
    base_bundle_id uuid NOT NULL REFERENCES bundles(id) ON DELETE CASCADE,
    base_file_hash text NOT NULL,
    patch_file_hash text NOT NULL,
    patch_storage_uri text NOT NULL,
    order_index integer NOT NULL DEFAULT 0
);

CREATE INDEX bundles_target_app_version_idx ON bundles(target_app_version);
CREATE INDEX bundles_fingerprint_hash_idx ON bundles(fingerprint_hash);
CREATE INDEX bundles_channel_idx ON bundles(channel);
CREATE INDEX bundles_rollout_idx ON bundles(rollout_cohort_count);
CREATE INDEX bundles_target_cohorts_idx ON bundles USING GIN (target_cohorts);
CREATE INDEX bundle_patches_bundle_id_idx ON bundle_patches(bundle_id);
CREATE INDEX bundle_patches_base_bundle_id_idx ON bundle_patches(base_bundle_id);
