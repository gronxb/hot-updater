CREATE TABLE channels (
  id varchar(255) PRIMARY KEY NOT NULL,
  name varchar(255) NOT NULL
);

CREATE TABLE bundles (
  id uuid PRIMARY KEY NOT NULL,
  platform text NOT NULL,
  file_hash text NOT NULL,
  git_commit_hash text,
  storage_uri text NOT NULL,
  archive_byte_size double precision NOT NULL,
  metadata json NOT NULL DEFAULT '{}'::json,
  manifest_storage_uri text,
  manifest_file_hash text,
  asset_base_storage_uri text
);

CREATE TABLE bundle_patches (
  id varchar(255) PRIMARY KEY NOT NULL,
  bundle_id uuid NOT NULL,
  base_bundle_id uuid NOT NULL,
  base_file_hash text NOT NULL,
  patch_file_hash text NOT NULL,
  patch_storage_uri text NOT NULL,
  byte_size double precision NOT NULL,
  order_index integer NOT NULL DEFAULT 0
);

CREATE TABLE releases (
  id uuid PRIMARY KEY NOT NULL,
  revision integer NOT NULL,
  scope_key varchar(2048) NOT NULL,
  channel_id varchar(255) NOT NULL,
  platform text NOT NULL,
  kind text NOT NULL,
  bundle_id uuid,
  strategy text NOT NULL,
  target_app_version text,
  fingerprint_hash text,
  enabled boolean NOT NULL,
  should_force_update boolean NOT NULL,
  message text,
  rollout_cohort_count integer NOT NULL DEFAULT 1000,
  target_cohorts json NOT NULL DEFAULT '[]'::json,
  operation text NOT NULL,
  source_release_id uuid,
  created_at_ms double precision NOT NULL,
  updated_at_ms double precision NOT NULL
);

CREATE TABLE release_catalogs (
  scope_key varchar(2048) PRIMARY KEY NOT NULL,
  catalog_id varchar(255) NOT NULL,
  strategy text NOT NULL,
  channel_id varchar(255) NOT NULL,
  channel_key varchar(1400) NOT NULL,
  platform text NOT NULL,
  fingerprint_hash text,
  generation double precision NOT NULL,
  payload text NOT NULL,
  catalog_hash varchar(71) NOT NULL,
  byte_size integer NOT NULL,
  is_tombstone boolean NOT NULL,
  updated_at_ms double precision NOT NULL
);

CREATE TABLE bundle_events (
  id uuid PRIMARY KEY NOT NULL,
  type varchar(32) NOT NULL,
  install_id varchar(255) COLLATE "C" NOT NULL,
  user_id varchar(255) COLLATE "C",
  from_release_id uuid,
  from_bundle_id uuid,
  to_release_id uuid,
  to_bundle_id uuid NOT NULL,
  platform text COLLATE "C" NOT NULL,
  app_version text NOT NULL,
  channel text COLLATE "C" NOT NULL,
  metadata json NOT NULL,
  received_at_ms double precision NOT NULL
);

CREATE TABLE bundle_event_heads (
  install_id varchar(255) COLLATE "C" PRIMARY KEY NOT NULL,
  id uuid NOT NULL,
  received_at_ms double precision NOT NULL,
  user_id varchar(255) COLLATE "C",
  platform text COLLATE "C" NOT NULL,
  channel text COLLATE "C" NOT NULL,
  type varchar(32) NOT NULL,
  from_bundle_id uuid,
  to_bundle_id uuid NOT NULL
);

CREATE TABLE api_keys (
  id varchar(255) PRIMARY KEY NOT NULL,
  hash text NOT NULL,
  name text NOT NULL,
  prefix text NOT NULL,
  role text NOT NULL,
  created_at_ms double precision NOT NULL,
  revoked_at_ms double precision
);

CREATE TABLE private_hot_updater_settings (
  key varchar(255) PRIMARY KEY NOT NULL,
  value text NOT NULL DEFAULT '1.0.0'
);

CREATE UNIQUE INDEX channels_name_key ON channels (name);

CREATE INDEX bundle_patches_bundle_id_idx ON bundle_patches (bundle_id);

CREATE INDEX bundle_patches_base_bundle_id_idx ON bundle_patches (base_bundle_id);

CREATE INDEX releases_scope_order_idx ON releases (scope_key, id);

CREATE INDEX releases_channel_platform_order_idx ON releases (channel_id, platform, id);

CREATE INDEX releases_bundle_id_idx ON releases (bundle_id);

CREATE INDEX releases_fingerprint_hash_idx ON releases (fingerprint_hash);

CREATE INDEX releases_enabled_idx ON releases (enabled);

CREATE INDEX release_catalogs_channel_idx ON release_catalogs (channel_id);

CREATE INDEX bundle_events_received_at_idx ON bundle_events (received_at_ms, id);

CREATE INDEX bundle_events_latest_idx ON bundle_events (install_id, received_at_ms, id);

CREATE INDEX bundle_events_install_idx ON bundle_events (install_id, type, received_at_ms, id);

CREATE INDEX bundle_events_from_bundle_idx ON bundle_events (
  type,
  platform,
  channel,
  from_bundle_id,
  received_at_ms,
  id
);

CREATE INDEX bundle_events_to_bundle_idx ON bundle_events (
  type,
  platform,
  channel,
  to_bundle_id,
  received_at_ms,
  id
);

CREATE INDEX bundle_event_heads_user_idx ON bundle_event_heads (user_id, install_id);

CREATE INDEX bundle_event_heads_scope_idx ON bundle_event_heads (platform, channel, received_at_ms);

CREATE INDEX bundle_event_heads_from_idx ON bundle_event_heads (
  type,
  platform,
  channel,
  from_bundle_id,
  received_at_ms
);

CREATE INDEX bundle_event_heads_to_idx ON bundle_event_heads (
  type,
  platform,
  channel,
  to_bundle_id,
  received_at_ms
);

CREATE UNIQUE INDEX api_keys_hash_key ON api_keys (hash);

CREATE INDEX api_keys_created_at_idx ON api_keys (created_at_ms, id);

ALTER TABLE channels
ADD CONSTRAINT channels_id_length_check CHECK (char_length(id) BETWEEN 1 AND 255);

ALTER TABLE channels
ADD CONSTRAINT channels_name_length_check CHECK (char_length(name) BETWEEN 1 AND 255);

ALTER TABLE bundles
ADD CONSTRAINT bundles_archive_byte_size_check CHECK (
  archive_byte_size >= 0
  AND archive_byte_size <= 9007199254740991
);

ALTER TABLE bundle_patches
ADD CONSTRAINT bundle_patches_byte_size_check CHECK (
  byte_size >= 0
  AND byte_size <= 9007199254740991
);

ALTER TABLE releases
ADD CONSTRAINT releases_revision_check CHECK (revision >= 1);

ALTER TABLE releases
ADD CONSTRAINT releases_kind_bundle_check CHECK (
  (
    kind = 'BUNDLE'
    AND bundle_id IS NOT NULL
  )
  OR (
    kind = 'EMBEDDED'
    AND bundle_id IS NULL
  )
);

ALTER TABLE releases
ADD CONSTRAINT releases_strategy_target_check CHECK (
  (
    strategy = 'APP_VERSION'
    AND target_app_version IS NOT NULL
    AND fingerprint_hash IS NULL
  )
  OR (
    strategy = 'FINGERPRINT'
    AND target_app_version IS NULL
    AND fingerprint_hash IS NOT NULL
  )
);

ALTER TABLE releases
ADD CONSTRAINT releases_rollout_cohort_count_check CHECK (
  rollout_cohort_count >= 0
  AND rollout_cohort_count <= 1000
);

ALTER TABLE releases
ADD CONSTRAINT releases_operation_check CHECK (operation IN ('DEPLOY', 'PROMOTE', 'ROLLBACK'));

ALTER TABLE release_catalogs
ADD CONSTRAINT release_catalogs_strategy_target_check CHECK (
  (
    strategy = 'APP_VERSION'
    AND fingerprint_hash IS NULL
  )
  OR (
    strategy = 'FINGERPRINT'
    AND fingerprint_hash IS NOT NULL
  )
);

ALTER TABLE release_catalogs
ADD CONSTRAINT release_catalogs_generation_check CHECK (
  generation >= 1
  AND generation <= 9007199254740991
);

ALTER TABLE release_catalogs
ADD CONSTRAINT release_catalogs_byte_size_check CHECK (
  byte_size >= 0
  AND byte_size <= 262144
);

ALTER TABLE bundle_events
ADD CONSTRAINT bundle_events_type_check CHECK (
  type IN (
    'UPDATE_DOWNLOADED',
    'UPDATE_APPLIED',
    'RECOVERED',
    'UNCHANGED'
  )
);

ALTER TABLE bundle_events
ADD CONSTRAINT bundle_events_platform_check CHECK (platform IN ('ios', 'android'));

ALTER TABLE bundle_events
ADD CONSTRAINT bundle_events_shape_check CHECK (
  (
    (
      type IN (
        'UPDATE_DOWNLOADED',
        'UPDATE_APPLIED',
        'RECOVERED'
      )
    )
    AND from_bundle_id IS NOT NULL
  )
  OR (
    type = 'UNCHANGED'
    AND from_bundle_id IS NULL
  )
);

ALTER TABLE bundle_events
ADD CONSTRAINT bundle_events_received_at_check CHECK (received_at_ms >= 0);

ALTER TABLE api_keys
ADD CONSTRAINT api_keys_role_check CHECK (role = 'client');

ALTER TABLE api_keys
ADD CONSTRAINT api_keys_created_at_check CHECK (created_at_ms >= 0);

ALTER TABLE api_keys
ADD CONSTRAINT api_keys_revoked_at_check CHECK (
  revoked_at_ms IS NULL
  OR revoked_at_ms >= 0
);

ALTER TABLE bundle_patches
ADD CONSTRAINT bundle_patches_bundle_id_fk FOREIGN key (bundle_id) REFERENCES bundles (id) ON UPDATE RESTRICT ON DELETE CASCADE;

ALTER TABLE bundle_patches
ADD CONSTRAINT bundle_patches_base_bundle_id_fk FOREIGN key (base_bundle_id) REFERENCES bundles (id) ON UPDATE RESTRICT ON DELETE CASCADE;

ALTER TABLE releases
ADD CONSTRAINT releases_channel_id_fk FOREIGN key (channel_id) REFERENCES channels (id) ON UPDATE RESTRICT ON DELETE RESTRICT;

ALTER TABLE releases
ADD CONSTRAINT releases_bundle_id_fk FOREIGN key (bundle_id) REFERENCES bundles (id) ON UPDATE RESTRICT ON DELETE RESTRICT;

ALTER TABLE releases
ADD CONSTRAINT releases_source_release_id_fk FOREIGN key (source_release_id) REFERENCES releases (id) ON UPDATE RESTRICT ON DELETE SET NULL;

ALTER TABLE release_catalogs
ADD CONSTRAINT release_catalogs_channel_id_fk FOREIGN key (channel_id) REFERENCES channels (id) ON UPDATE RESTRICT ON DELETE RESTRICT;

INSERT INTO
  private_hot_updater_settings (key, value)
VALUES
  ('schema.core', '1.0.0')
ON CONFLICT (key) DO UPDATE
SET
  value = '1.0.0';