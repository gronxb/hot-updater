CREATE TABLE bundle_channels (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE
);

INSERT INTO bundle_channels (id, name) VALUES ('production', 'production');

CREATE TABLE bundles (
    id TEXT PRIMARY KEY,
    platform TEXT NOT NULL CHECK (platform IN ('ios', 'android')),
    target_app_version TEXT,
    should_force_update INTEGER NOT NULL CHECK (should_force_update IN (0, 1)),
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    file_hash TEXT NOT NULL,
    git_commit_hash TEXT,
    message TEXT,
    channel TEXT NOT NULL DEFAULT 'production',
    channel_id TEXT NOT NULL,
    storage_uri TEXT NOT NULL,
    fingerprint_hash TEXT,
    metadata JSONB DEFAULT '{}',
    manifest_storage_uri TEXT,
    manifest_file_hash TEXT,
    asset_base_storage_uri TEXT,
    rollout_cohort_count INTEGER DEFAULT 1000
      CHECK (rollout_cohort_count >= 0 AND rollout_cohort_count <= 1000),
    target_cohorts TEXT,
    FOREIGN KEY (channel_id) REFERENCES bundle_channels(id) ON DELETE RESTRICT,
    CHECK ((target_app_version IS NOT NULL) OR (fingerprint_hash IS NOT NULL))
);

CREATE TABLE bundle_patches (
    id TEXT PRIMARY KEY,
    bundle_id TEXT NOT NULL,
    base_bundle_id TEXT NOT NULL,
    base_file_hash TEXT NOT NULL,
    patch_file_hash TEXT NOT NULL,
    patch_storage_uri TEXT NOT NULL,
    order_index INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (bundle_id) REFERENCES bundles(id) ON DELETE CASCADE,
    FOREIGN KEY (base_bundle_id) REFERENCES bundles(id) ON DELETE CASCADE
);

CREATE TABLE bundle_events (
    id TEXT PRIMARY KEY NOT NULL,
    type TEXT NOT NULL,
    install_id TEXT NOT NULL,
    user_id TEXT,
    username TEXT,
    from_bundle_id TEXT,
    to_bundle_id TEXT NOT NULL,
    platform TEXT NOT NULL,
    app_version TEXT NOT NULL,
    channel TEXT NOT NULL,
    cohort TEXT NOT NULL,
    update_strategy TEXT,
    fingerprint_hash TEXT,
    sdk_version TEXT,
    received_at_ms REAL NOT NULL,
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

CREATE INDEX bundles_target_app_version_idx ON bundles(target_app_version);
CREATE INDEX bundles_fingerprint_hash_idx ON bundles(fingerprint_hash);
CREATE INDEX bundles_channel_idx ON bundles(channel);
CREATE INDEX bundles_channel_id_idx ON bundles(channel_id);
CREATE INDEX bundles_rollout_idx ON bundles(rollout_cohort_count);
CREATE INDEX bundle_patches_bundle_id_idx ON bundle_patches(bundle_id);
CREATE INDEX bundle_patches_base_bundle_id_idx ON bundle_patches(base_bundle_id);
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
