CREATE TABLE channels (
  id TEXT COLLATE BINARY PRIMARY KEY NOT NULL,
  name TEXT COLLATE BINARY NOT NULL,
  CONSTRAINT channels_id_length_check CHECK (length(id) BETWEEN 1 AND 255),
  CONSTRAINT channels_name_length_check CHECK (length(name) BETWEEN 1 AND 255)
);

CREATE TABLE bundles (
  id TEXT PRIMARY KEY NOT NULL,
  platform TEXT NOT NULL,
  file_hash TEXT NOT NULL,
  git_commit_hash TEXT,
  storage_uri TEXT NOT NULL,
  archive_byte_size REAL NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  manifest_storage_uri TEXT,
  manifest_file_hash TEXT,
  asset_base_storage_uri TEXT,
  CONSTRAINT bundles_archive_byte_size_check CHECK (
    archive_byte_size >= 0 AND archive_byte_size <= 9007199254740991
  )
);

CREATE TABLE bundle_patches (
  id TEXT PRIMARY KEY NOT NULL,
  bundle_id TEXT NOT NULL,
  base_bundle_id TEXT NOT NULL,
  base_file_hash TEXT NOT NULL,
  patch_file_hash TEXT NOT NULL,
  patch_storage_uri TEXT NOT NULL,
  byte_size REAL NOT NULL,
  order_index INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT bundle_patches_byte_size_check CHECK (
    byte_size >= 0 AND byte_size <= 9007199254740991
  ),
  CONSTRAINT bundle_patches_bundle_id_fk FOREIGN KEY (bundle_id)
    REFERENCES bundles(id) ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT bundle_patches_base_bundle_id_fk FOREIGN KEY (base_bundle_id)
    REFERENCES bundles(id) ON UPDATE RESTRICT ON DELETE CASCADE
);

CREATE TABLE releases (
  id TEXT PRIMARY KEY NOT NULL,
  revision INTEGER NOT NULL,
  scope_key TEXT COLLATE BINARY NOT NULL,
  channel_id TEXT COLLATE BINARY NOT NULL,
  platform TEXT NOT NULL,
  kind TEXT NOT NULL,
  bundle_id TEXT,
  strategy TEXT NOT NULL,
  target_app_version TEXT,
  fingerprint_hash TEXT,
  enabled INTEGER NOT NULL,
  should_force_update INTEGER NOT NULL,
  message TEXT,
  rollout_cohort_count INTEGER NOT NULL DEFAULT 1000,
  target_cohorts TEXT NOT NULL DEFAULT '[]',
  operation TEXT NOT NULL,
  source_release_id TEXT,
  created_at_ms REAL NOT NULL,
  updated_at_ms REAL NOT NULL,
  CONSTRAINT releases_revision_check CHECK (revision >= 1),
  CONSTRAINT releases_kind_bundle_check CHECK (
    (kind = 'BUNDLE' AND bundle_id IS NOT NULL)
    OR (kind = 'EMBEDDED' AND bundle_id IS NULL)
  ),
  CONSTRAINT releases_strategy_target_check CHECK (
    (strategy = 'APP_VERSION' AND target_app_version IS NOT NULL AND fingerprint_hash IS NULL)
    OR (strategy = 'FINGERPRINT' AND target_app_version IS NULL AND fingerprint_hash IS NOT NULL)
  ),
  CONSTRAINT releases_rollout_cohort_count_check CHECK (
    rollout_cohort_count >= 0 AND rollout_cohort_count <= 1000
  ),
  CONSTRAINT releases_operation_check CHECK (
    operation IN ('DEPLOY', 'PROMOTE', 'ROLLBACK')
  ),
  CONSTRAINT releases_channel_id_fk FOREIGN KEY (channel_id)
    REFERENCES channels(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT releases_bundle_id_fk FOREIGN KEY (bundle_id)
    REFERENCES bundles(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT releases_source_release_id_fk FOREIGN KEY (source_release_id)
    REFERENCES releases(id) ON UPDATE RESTRICT ON DELETE SET NULL
);

CREATE TABLE release_catalogs (
  scope_key TEXT COLLATE BINARY PRIMARY KEY NOT NULL,
  authority_id TEXT NOT NULL,
  strategy TEXT NOT NULL,
  channel_id TEXT COLLATE BINARY NOT NULL,
  channel_key TEXT COLLATE BINARY NOT NULL,
  platform TEXT NOT NULL,
  fingerprint_hash TEXT,
  generation REAL NOT NULL,
  payload TEXT NOT NULL,
  catalog_hash TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  is_tombstone INTEGER NOT NULL,
  updated_at_ms REAL NOT NULL,
  CONSTRAINT release_catalogs_strategy_target_check CHECK (
    (strategy = 'APP_VERSION' AND fingerprint_hash IS NULL)
    OR (strategy = 'FINGERPRINT' AND fingerprint_hash IS NOT NULL)
  ),
  CONSTRAINT release_catalogs_generation_check CHECK (
    generation >= 1 AND generation <= 9007199254740991
  ),
  CONSTRAINT release_catalogs_byte_size_check CHECK (
    byte_size >= 0 AND byte_size <= 262144
  ),
  CONSTRAINT release_catalogs_channel_id_fk FOREIGN KEY (channel_id)
    REFERENCES channels(id) ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE TABLE bundle_events (
  id TEXT PRIMARY KEY NOT NULL,
  type TEXT NOT NULL,
  install_id TEXT NOT NULL,
  user_id TEXT,
  username TEXT,
  from_release_id TEXT,
  from_bundle_id TEXT,
  to_release_id TEXT,
  to_bundle_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  app_version TEXT NOT NULL,
  channel TEXT NOT NULL,
  cohort TEXT NOT NULL,
  update_strategy TEXT,
  fingerprint_hash TEXT,
  sdk_version TEXT,
  received_at_ms REAL NOT NULL,
  CONSTRAINT bundle_events_type_check CHECK (
    type IN ('UPDATE_APPLIED', 'RECOVERED', 'RELEASE_ADOPTED', 'UNCHANGED')
  ),
  CONSTRAINT bundle_events_platform_check CHECK (
    platform IN ('ios', 'android')
  ),
  CONSTRAINT bundle_events_shape_check CHECK (
    (
      type IN ('UPDATE_APPLIED', 'RECOVERED', 'RELEASE_ADOPTED')
      AND from_bundle_id IS NOT NULL
      AND update_strategy IS NOT NULL
      AND update_strategy IN ('fingerprint', 'appVersion')
    ) OR (
      type = 'UNCHANGED'
      AND from_bundle_id IS NULL
      AND update_strategy IS NULL
    )
  ),
  CONSTRAINT bundle_events_received_at_check CHECK (received_at_ms >= 0)
);

CREATE TABLE api_keys (
  id TEXT PRIMARY KEY NOT NULL,
  hash TEXT NOT NULL,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  role TEXT NOT NULL,
  created_at_ms REAL NOT NULL,
  revoked_at_ms REAL,
  CONSTRAINT api_keys_role_check CHECK (role = 'client'),
  CONSTRAINT api_keys_created_at_check CHECK (created_at_ms >= 0),
  CONSTRAINT api_keys_revoked_at_check CHECK (
    revoked_at_ms IS NULL OR revoked_at_ms >= 0
  )
);

CREATE TABLE private_hot_updater_settings (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL DEFAULT '1.0.0'
);

CREATE UNIQUE INDEX channels_name_key ON channels(name);
CREATE INDEX bundle_patches_bundle_id_idx ON bundle_patches(bundle_id);
CREATE INDEX bundle_patches_base_bundle_id_idx ON bundle_patches(base_bundle_id);
CREATE INDEX releases_scope_order_idx ON releases(scope_key, id);
CREATE INDEX releases_channel_platform_order_idx ON releases(channel_id, platform, id);
CREATE INDEX releases_bundle_id_idx ON releases(bundle_id);
CREATE INDEX releases_fingerprint_hash_idx ON releases(fingerprint_hash);
CREATE INDEX releases_enabled_idx ON releases(enabled);
CREATE INDEX release_catalogs_channel_idx ON release_catalogs(channel_id);
CREATE INDEX release_catalogs_authority_strategy_idx ON release_catalogs(authority_id, strategy);
CREATE INDEX bundle_events_received_at_idx ON bundle_events(received_at_ms, id);
CREATE INDEX bundle_events_install_idx ON bundle_events(install_id, received_at_ms, id);
CREATE INDEX bundle_events_user_id_idx ON bundle_events(user_id, received_at_ms, id);
CREATE INDEX bundle_events_username_idx ON bundle_events(username, received_at_ms, id);
CREATE INDEX bundle_events_to_bundle_idx ON bundle_events(type, to_bundle_id, received_at_ms, id);
CREATE INDEX bundle_events_from_bundle_idx ON bundle_events(type, from_bundle_id, received_at_ms, id);
CREATE INDEX bundle_events_to_release_idx ON bundle_events(type, to_release_id, received_at_ms, id);
CREATE INDEX bundle_events_from_release_idx ON bundle_events(type, from_release_id, received_at_ms, id);
CREATE UNIQUE INDEX api_keys_hash_key ON api_keys(hash);
CREATE INDEX api_keys_created_at_idx ON api_keys(created_at_ms, id);
