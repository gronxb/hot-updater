-- HotUpdater.bundles

CREATE TYPE platforms AS ENUM ('ios', 'android');

CREATE TABLE bundle_channels (
    id text PRIMARY KEY,
    name text NOT NULL UNIQUE
);

INSERT INTO bundle_channels (id, name) VALUES ('production', 'production');

CREATE TABLE bundles (
    id uuid PRIMARY KEY,
    platform platforms NOT NULL,
    should_force_update boolean NOT NULL,
    enabled boolean NOT NULL,
    file_hash text NOT NULL,
    git_commit_hash text,
    message text,
    channel text NOT NULL DEFAULT 'production',
    channel_id text NOT NULL
      REFERENCES bundle_channels(id) ON DELETE RESTRICT,
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
CREATE INDEX bundles_channel_id_idx ON bundles(channel_id);
CREATE INDEX bundles_rollout_idx ON bundles(rollout_cohort_count);
CREATE INDEX bundles_target_cohorts_idx ON bundles USING GIN (target_cohorts);
CREATE INDEX bundle_patches_bundle_id_idx ON bundle_patches(bundle_id);
CREATE INDEX bundle_patches_base_bundle_id_idx ON bundle_patches(base_bundle_id);

-- HotUpdater.bundle_events

CREATE TABLE bundle_events (
    id uuid PRIMARY KEY NOT NULL,
    type text NOT NULL,
    install_id text NOT NULL,
    user_id text,
    username text,
    from_bundle_id uuid,
    to_bundle_id uuid NOT NULL,
    platform text NOT NULL,
    app_version text NOT NULL,
    channel text NOT NULL,
    cohort text NOT NULL,
    update_strategy text,
    fingerprint_hash text,
    sdk_version text,
    received_at_ms double precision NOT NULL,
    CONSTRAINT bundle_events_type_v038_check
      CHECK (type IN ('UPDATE_APPLIED', 'RECOVERED', 'UNCHANGED')),
    CONSTRAINT bundle_events_update_strategy_v038_check
      CHECK (update_strategy IS NULL OR update_strategy IN ('fingerprint', 'appVersion')),
    CONSTRAINT bundle_events_shape_v038_check
      CHECK (
        (type IN ('UPDATE_APPLIED', 'RECOVERED')
          AND from_bundle_id IS NOT NULL
          AND update_strategy IS NOT NULL)
        OR (type = 'UNCHANGED'
          AND from_bundle_id IS NULL
          AND update_strategy IS NULL)
      )
);

CREATE INDEX bundle_events_installed_bundle_idx
  ON bundle_events(type, to_bundle_id, received_at_ms, id);
CREATE INDEX bundle_events_recovered_bundle_idx
  ON bundle_events(type, from_bundle_id, received_at_ms, id);
CREATE INDEX bundle_events_install_idx
  ON bundle_events(install_id, received_at_ms, id);
CREATE INDEX bundle_events_user_id_idx
  ON bundle_events(user_id, received_at_ms, id);
CREATE INDEX bundle_events_username_idx
  ON bundle_events(username, received_at_ms, id);
CREATE INDEX bundle_events_cohort_idx
  ON bundle_events(cohort, type, received_at_ms, id);
CREATE INDEX bundle_events_received_at_idx
  ON bundle_events(received_at_ms, id);
