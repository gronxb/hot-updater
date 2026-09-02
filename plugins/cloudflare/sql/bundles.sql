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
  catalog_id TEXT NOT NULL,
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
  insights_write_version INTEGER NOT NULL,
  insights_install_key TEXT COLLATE BINARY NOT NULL,
  insights_row_bytes INTEGER NOT NULL,
  insights_event_json TEXT NOT NULL,
  insights_aliases_json TEXT NOT NULL,
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
  CONSTRAINT bundle_events_received_at_check CHECK (received_at_ms >= 0),
  CONSTRAINT bundle_events_id_check CHECK (
    length(id) = 36
    AND substr(id, 9, 1) = '-'
    AND substr(id, 14, 1) = '-'
    AND substr(id, 15, 1) = '7'
    AND substr(id, 19, 1) = '-'
    AND substr(id, 20, 1) IN ('8', '9', 'a', 'b')
    AND substr(id, 24, 1) = '-'
    AND length(replace(id, '-', '')) = 32
    AND replace(id, '-', '') NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT bundle_events_insights_write_version_check CHECK (
    insights_write_version = 2
  ),
  CONSTRAINT bundle_events_insights_install_key_check CHECK (
    length(insights_install_key) = 64
    AND insights_install_key NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT bundle_events_insights_row_bytes_check CHECK (
    insights_row_bytes >= 1 AND insights_row_bytes <= 20480
      AND json_valid(insights_event_json)
      AND length(CAST(insights_event_json AS BLOB)) = insights_row_bytes
      AND json_valid(insights_aliases_json)
  )
);

CREATE TABLE private_hot_updater_insights_source_state (
  id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
  version INTEGER NOT NULL CHECK (version = 2),
  source_id TEXT COLLATE BINARY NOT NULL,
  database_namespace TEXT COLLATE BINARY,
  status TEXT NOT NULL CHECK (status IN ('preparing', 'ready', 'failed')),
  generation INTEGER NOT NULL CHECK (
    generation >= 0 AND generation <= 9007199254740991
  ),
  backfill_upper_received_at_ms REAL,
  backfill_upper_id TEXT COLLATE BINARY,
  backfill_after_received_at_ms REAL,
  backfill_after_id TEXT COLLATE BINARY,
  CONSTRAINT insights_database_namespace_check CHECK (
    database_namespace IS NULL OR (
      length(database_namespace) = 36
      AND substr(database_namespace, 9, 1) = '-'
      AND substr(database_namespace, 14, 1) = '-'
      AND substr(database_namespace, 19, 1) = '-'
      AND substr(database_namespace, 24, 1) = '-'
      AND replace(database_namespace, '-', '') NOT GLOB '*[^0-9a-f]*'
    )
  )
);

CREATE TABLE private_hot_updater_insights_source_events (
  generation INTEGER PRIMARY KEY NOT NULL,
  event_id TEXT COLLATE BINARY UNIQUE NOT NULL,
  received_at_ms REAL NOT NULL,
  row_bytes INTEGER NOT NULL,
  event_json TEXT NOT NULL,
  CONSTRAINT insights_source_generation_check CHECK (generation >= 1),
  CONSTRAINT insights_source_event_fk FOREIGN KEY (event_id)
    REFERENCES bundle_events(id) ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE TABLE private_hot_updater_insights_pending_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT COLLATE BINARY UNIQUE NOT NULL,
  received_at_ms REAL NOT NULL,
  row_bytes INTEGER NOT NULL,
  event_json TEXT NOT NULL,
  CONSTRAINT insights_pending_event_fk FOREIGN KEY (event_id)
    REFERENCES bundle_events(id) ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE TABLE private_hot_updater_insights_installation_events (
  install_id TEXT COLLATE BINARY NOT NULL,
  received_at_ms REAL NOT NULL,
  event_id TEXT COLLATE BINARY PRIMARY KEY NOT NULL,
  row_bytes INTEGER NOT NULL,
  CONSTRAINT insights_installation_event_fk FOREIGN KEY (event_id)
    REFERENCES bundle_events(id) ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE TABLE private_hot_updater_insights_bundle_events (
  bundle_id TEXT COLLATE BINARY NOT NULL,
  received_at_ms REAL NOT NULL,
  event_id TEXT COLLATE BINARY PRIMARY KEY NOT NULL,
  row_bytes INTEGER NOT NULL,
  CONSTRAINT insights_bundle_event_fk FOREIGN KEY (event_id)
    REFERENCES bundle_events(id) ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE TABLE private_hot_updater_insights_live_installations (
  install_key TEXT COLLATE BINARY PRIMARY KEY NOT NULL,
  install_id TEXT NOT NULL,
  event_id TEXT COLLATE BINARY NOT NULL,
  received_at_ms REAL NOT NULL,
  row_bytes INTEGER NOT NULL,
  CONSTRAINT insights_live_install_key_check CHECK (
    length(install_key) = 64
    AND install_key NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT insights_live_event_fk FOREIGN KEY (event_id)
    REFERENCES bundle_events(id) ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE TABLE private_hot_updater_insights_installation_aliases (
  alias_id INTEGER PRIMARY KEY NOT NULL,
  install_key TEXT COLLATE BINARY NOT NULL,
  install_id TEXT NOT NULL,
  alias_kind TEXT NOT NULL,
  alias_value TEXT COLLATE BINARY NOT NULL,
  folded_value TEXT COLLATE BINARY NOT NULL,
  first_generation INTEGER NOT NULL,
  CONSTRAINT insights_alias_key_check CHECK (
    length(install_key) = 64
    AND install_key NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT insights_alias_kind_check CHECK (
    alias_kind IN ('installId', 'userId', 'username')
  ),
  CONSTRAINT insights_alias_generation_check CHECK (first_generation >= 1),
  UNIQUE (install_key, alias_kind, alias_value)
);

CREATE TABLE private_hot_updater_insights_installation_versions (
  install_key TEXT COLLATE BINARY NOT NULL,
  generation INTEGER NOT NULL,
  install_id TEXT NOT NULL,
  event_id TEXT COLLATE BINARY NOT NULL,
  received_at_ms REAL NOT NULL,
  row_bytes INTEGER NOT NULL,
  PRIMARY KEY (install_key, generation),
  CONSTRAINT insights_version_key_check CHECK (
    length(install_key) = 64
    AND install_key NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT insights_version_generation_check CHECK (generation >= 1),
  CONSTRAINT insights_version_event_fk FOREIGN KEY (event_id)
    REFERENCES bundle_events(id) ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE TRIGGER bundle_events_insights_writer_fence
BEFORE INSERT ON bundle_events
WHEN NEW.insights_write_version IS NOT 2
  OR length(NEW.id) <> 36
  OR substr(NEW.id, 9, 1) <> '-'
  OR substr(NEW.id, 14, 1) <> '-'
  OR substr(NEW.id, 15, 1) <> '7'
  OR substr(NEW.id, 19, 1) <> '-'
  OR substr(NEW.id, 20, 1) NOT IN ('8', '9', 'a', 'b')
  OR substr(NEW.id, 24, 1) <> '-'
  OR length(replace(NEW.id, '-', '')) <> 32
  OR replace(NEW.id, '-', '') GLOB '*[^0-9a-f]*'
  OR length(NEW.insights_install_key) <> 64
  OR NEW.insights_install_key GLOB '*[^0-9a-f]*'
  OR NEW.insights_row_bytes IS NULL
  OR NEW.insights_row_bytes < 1
  OR NEW.insights_row_bytes > 20480
  OR NEW.insights_event_json IS NULL
  OR NOT json_valid(NEW.insights_event_json)
  OR length(CAST(NEW.insights_event_json AS BLOB)) <> NEW.insights_row_bytes
  OR NEW.insights_aliases_json IS NULL
  OR NOT json_valid(NEW.insights_aliases_json)
  OR NOT EXISTS (
    SELECT 1 FROM private_hot_updater_insights_source_state
    WHERE id = 1 AND generation < 9007199254740991
  )
  OR NOT EXISTS (
    SELECT 1 FROM private_hot_updater_insights_source_state
    WHERE id = 1 AND version = 2 AND status IN ('preparing', 'ready')
  )
BEGIN
  SELECT RAISE(ABORT, 'HOT_UPDATER_INSIGHTS_V2_NOT_READY');
END;

CREATE TRIGGER insights_live_install_key_collision
BEFORE INSERT ON private_hot_updater_insights_live_installations
WHEN EXISTS (
  SELECT 1 FROM private_hot_updater_insights_live_installations
  WHERE install_key = NEW.install_key AND install_id <> NEW.install_id
)
BEGIN
  SELECT RAISE(ABORT, 'HOT_UPDATER_INSIGHTS_INSTALL_KEY_COLLISION');
END;

CREATE TRIGGER insights_alias_install_key_collision
BEFORE INSERT ON private_hot_updater_insights_installation_aliases
WHEN EXISTS (
  SELECT 1 FROM private_hot_updater_insights_installation_aliases
  WHERE install_key = NEW.install_key AND install_id <> NEW.install_id
)
BEGIN
  SELECT RAISE(ABORT, 'HOT_UPDATER_INSIGHTS_INSTALL_KEY_COLLISION');
END;

CREATE TRIGGER bundle_events_insights_projection
AFTER INSERT ON bundle_events
BEGIN
  INSERT INTO private_hot_updater_insights_pending_events (
    event_id, received_at_ms, row_bytes, event_json
  )
  SELECT NEW.id, NEW.received_at_ms, NEW.insights_row_bytes,
    NEW.insights_event_json
  FROM private_hot_updater_insights_source_state
  WHERE id = 1 AND version = 2 AND status = 'preparing';

  UPDATE private_hot_updater_insights_source_state
  SET generation = generation + 1
  WHERE id = 1 AND version = 2 AND status = 'ready'
    AND generation < 9007199254740991;

  INSERT INTO private_hot_updater_insights_source_events (
    generation, event_id, received_at_ms, row_bytes, event_json
  )
  SELECT generation, NEW.id, NEW.received_at_ms, NEW.insights_row_bytes,
    NEW.insights_event_json
  FROM private_hot_updater_insights_source_state
  WHERE id = 1 AND version = 2 AND status = 'ready';

  INSERT OR IGNORE INTO private_hot_updater_insights_installation_aliases (
    install_key, install_id, alias_kind, alias_value, folded_value,
    first_generation
  )
  SELECT NEW.insights_install_key, NEW.install_id,
    json_extract(alias.value, '$.kind'),
    json_extract(alias.value, '$.value'),
    json_extract(alias.value, '$.folded'), source.generation
  FROM private_hot_updater_insights_source_state AS source,
    json_each(NEW.insights_aliases_json) AS alias
  WHERE source.id = 1 AND source.version = 2 AND source.status = 'ready';

  INSERT INTO private_hot_updater_insights_installation_events (
    install_id, received_at_ms, event_id, row_bytes
  )
  SELECT NEW.install_id, NEW.received_at_ms, NEW.id, NEW.insights_row_bytes
  WHERE NEW.type IN ('UPDATE_APPLIED', 'RECOVERED')
    AND EXISTS (
      SELECT 1 FROM private_hot_updater_insights_source_state
      WHERE id = 1 AND version = 2 AND status = 'ready'
    );

  INSERT INTO private_hot_updater_insights_bundle_events (
    bundle_id, received_at_ms, event_id, row_bytes
  )
  SELECT CASE NEW.type
      WHEN 'UPDATE_APPLIED' THEN NEW.to_bundle_id
      WHEN 'RECOVERED' THEN NEW.from_bundle_id
    END,
    NEW.received_at_ms, NEW.id, NEW.insights_row_bytes
  WHERE NEW.type IN ('UPDATE_APPLIED', 'RECOVERED')
    AND EXISTS (
      SELECT 1 FROM private_hot_updater_insights_source_state
      WHERE id = 1 AND version = 2 AND status = 'ready'
    );

  INSERT INTO private_hot_updater_insights_live_installations (
    install_key, install_id, event_id, received_at_ms, row_bytes
  )
  SELECT NEW.insights_install_key, NEW.install_id, NEW.id,
    NEW.received_at_ms, NEW.insights_row_bytes
  FROM private_hot_updater_insights_source_state
  WHERE id = 1 AND version = 2 AND status = 'ready'
  ON CONFLICT(install_key) DO UPDATE SET
    event_id = excluded.event_id,
    received_at_ms = excluded.received_at_ms,
    row_bytes = excluded.row_bytes
  WHERE private_hot_updater_insights_live_installations.install_id
      = excluded.install_id
    AND (
      private_hot_updater_insights_live_installations.received_at_ms
        < excluded.received_at_ms
      OR (
        private_hot_updater_insights_live_installations.received_at_ms
          = excluded.received_at_ms
        AND private_hot_updater_insights_live_installations.event_id
          < excluded.event_id
      )
    );

  INSERT INTO private_hot_updater_insights_installation_versions (
    install_key, generation, install_id, event_id, received_at_ms, row_bytes
  )
  SELECT live.install_key, source.generation, live.install_id, live.event_id,
    live.received_at_ms, live.row_bytes
  FROM private_hot_updater_insights_source_state AS source
  JOIN private_hot_updater_insights_live_installations AS live
    ON live.install_key = NEW.insights_install_key
  WHERE source.id = 1 AND source.version = 2 AND source.status = 'ready';
END;

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

INSERT INTO private_hot_updater_insights_source_state (
  id, version, source_id, status, generation
) VALUES (
  1, 2, lower(hex(randomblob(16))), 'ready', 0
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
CREATE INDEX bundle_events_received_at_idx ON bundle_events(received_at_ms, id);
CREATE INDEX bundle_events_insights_backfill_idx
  ON bundle_events(insights_write_version, received_at_ms, id);
CREATE INDEX bundle_events_install_idx ON bundle_events(install_id, received_at_ms, id);
CREATE INDEX bundle_events_user_id_idx ON bundle_events(user_id, received_at_ms, id);
CREATE INDEX bundle_events_username_idx ON bundle_events(username, received_at_ms, id);
CREATE INDEX bundle_events_to_bundle_idx ON bundle_events(type, to_bundle_id, received_at_ms, id);
CREATE INDEX bundle_events_from_bundle_idx ON bundle_events(type, from_bundle_id, received_at_ms, id);
CREATE INDEX bundle_events_to_release_idx ON bundle_events(type, to_release_id, received_at_ms, id);
CREATE INDEX bundle_events_from_release_idx ON bundle_events(type, from_release_id, received_at_ms, id);
CREATE INDEX private_hot_updater_insights_source_event_order_idx
  ON private_hot_updater_insights_source_events(received_at_ms, event_id);
CREATE INDEX private_hot_updater_insights_installation_event_order_idx
  ON private_hot_updater_insights_installation_events(
    install_id, received_at_ms, event_id
  );
CREATE INDEX private_hot_updater_insights_bundle_event_order_idx
  ON private_hot_updater_insights_bundle_events(
    bundle_id, received_at_ms, event_id
  );
CREATE INDEX private_hot_updater_insights_alias_exact_idx
  ON private_hot_updater_insights_installation_aliases(
    alias_kind, alias_value, alias_id
  );
CREATE UNIQUE INDEX api_keys_hash_key ON api_keys(hash);
CREATE INDEX api_keys_created_at_idx ON api_keys(created_at_ms, id);
CREATE TABLE private_hot_updater_insights_job_heads (
  query_key TEXT PRIMARY KEY NOT NULL,
  query_json TEXT NOT NULL,
  active_job_id TEXT,
  publication_job_id TEXT,
  CONSTRAINT insights_job_heads_key_check CHECK (
    length(query_key) = 64 AND query_key NOT GLOB '*[^0-9a-f]*'
  )
);

CREATE TABLE private_hot_updater_insights_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  query_key TEXT NOT NULL,
  query_json TEXT NOT NULL,
  job_kind TEXT NOT NULL,
  status TEXT NOT NULL,
  as_of_ms REAL NOT NULL,
  source_id TEXT NOT NULL,
  source_generation INTEGER NOT NULL,
  source_alias_upper_id INTEGER NOT NULL,
  checkpoint_json TEXT NOT NULL,
  lease_epoch INTEGER NOT NULL DEFAULT 0,
  lease_until_ms REAL NOT NULL DEFAULT 0,
  claimable_at_ms REAL NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 0,
  publication_json TEXT,
  result_total INTEGER,
  completed_at_ms REAL,
  failure_code TEXT,
  CONSTRAINT insights_jobs_head_fk FOREIGN KEY (query_key)
    REFERENCES private_hot_updater_insights_job_heads(query_key)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT insights_jobs_kind_check CHECK (
    job_kind IN ('search', 'report')
  ),
  CONSTRAINT insights_jobs_status_check CHECK (
    status IN ('queued', 'preparing', 'ready', 'failed')
  ),
  CONSTRAINT insights_jobs_number_check CHECK (
    as_of_ms >= 0 AND source_generation >= 0 AND source_alias_upper_id >= 0
    AND lease_epoch >= 0
    AND lease_until_ms >= 0 AND claimable_at_ms >= 0 AND revision >= 0
    AND (result_total IS NULL OR result_total >= 0)
    AND (completed_at_ms IS NULL OR completed_at_ms >= 0)
  ),
  CONSTRAINT insights_jobs_failure_check CHECK (
    failure_code IS NULL
    OR failure_code IN ('preparation-failed', 'migration-poison')
  )
);

CREATE UNIQUE INDEX private_hot_updater_insights_job_head_active_idx
  ON private_hot_updater_insights_job_heads(active_job_id, query_key);
CREATE INDEX private_hot_updater_insights_job_claim_idx
  ON private_hot_updater_insights_jobs(status, claimable_at_ms, id);
CREATE INDEX private_hot_updater_insights_job_lease_idx
  ON private_hot_updater_insights_jobs(status, lease_until_ms, id);
CREATE INDEX private_hot_updater_insights_job_query_idx
  ON private_hot_updater_insights_jobs(query_key, status, id);

CREATE TABLE private_hot_updater_insights_job_latest (
  job_id TEXT NOT NULL,
  install_key TEXT NOT NULL,
  bucket_index INTEGER NOT NULL,
  install_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  received_at_ms REAL NOT NULL,
  row_bytes INTEGER NOT NULL,
  event_json TEXT NOT NULL,
  PRIMARY KEY (job_id, install_key, bucket_index),
  CONSTRAINT insights_job_latest_job_fk FOREIGN KEY (job_id)
    REFERENCES private_hot_updater_insights_jobs(id)
    ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT insights_job_latest_key_check CHECK (
    length(install_key) = 64 AND install_key NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT insights_job_latest_number_check CHECK (
    bucket_index >= -1 AND received_at_ms >= 0
    AND row_bytes >= 1 AND row_bytes <= 20480
  )
);

CREATE INDEX private_hot_updater_insights_job_latest_scan_idx
  ON private_hot_updater_insights_job_latest(
    job_id, bucket_index, install_key
  );

CREATE TABLE private_hot_updater_insights_job_memberships (
  job_id TEXT NOT NULL,
  count_key TEXT NOT NULL,
  install_key TEXT NOT NULL,
  install_id TEXT NOT NULL,
  section TEXT NOT NULL,
  metric TEXT NOT NULL,
  label TEXT NOT NULL,
  bucket_start_ms REAL NOT NULL,
  PRIMARY KEY (job_id, count_key, install_key),
  CONSTRAINT insights_job_memberships_job_fk FOREIGN KEY (job_id)
    REFERENCES private_hot_updater_insights_jobs(id)
    ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT insights_job_memberships_key_check CHECK (
    length(install_key) = 64 AND install_key NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT insights_job_memberships_bucket_check CHECK (
    bucket_start_ms >= -1
  )
);

CREATE TABLE private_hot_updater_insights_job_counts (
  job_id TEXT NOT NULL,
  count_key TEXT NOT NULL,
  section TEXT NOT NULL,
  metric TEXT NOT NULL,
  label TEXT NOT NULL,
  bucket_start_ms REAL NOT NULL,
  value INTEGER NOT NULL,
  PRIMARY KEY (job_id, count_key),
  CONSTRAINT insights_job_counts_job_fk FOREIGN KEY (job_id)
    REFERENCES private_hot_updater_insights_jobs(id)
    ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT insights_job_counts_value_check CHECK (
    bucket_start_ms >= -1 AND value >= 1
  )
);

CREATE INDEX private_hot_updater_insights_job_count_order_idx
  ON private_hot_updater_insights_job_counts(
    job_id, section, metric, count_key
  );
CREATE INDEX private_hot_updater_insights_job_count_series_idx
  ON private_hot_updater_insights_job_counts(
    job_id, section, metric, label, bucket_start_ms
  );

CREATE TABLE private_hot_updater_insights_job_order (
  job_id TEXT NOT NULL,
  section_key TEXT NOT NULL,
  order_key TEXT NOT NULL,
  count_key TEXT NOT NULL,
  label TEXT NOT NULL,
  value INTEGER NOT NULL,
  PRIMARY KEY (job_id, section_key, order_key),
  CONSTRAINT insights_job_order_job_fk FOREIGN KEY (job_id)
    REFERENCES private_hot_updater_insights_jobs(id)
    ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT insights_job_order_value_check CHECK (value >= 1)
);

CREATE TABLE private_hot_updater_insights_job_page_rows (
  job_id TEXT NOT NULL,
  section_key TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  filter_label TEXT NOT NULL,
  filter_ordinal INTEGER NOT NULL,
  row_bytes INTEGER NOT NULL,
  row_json TEXT NOT NULL,
  PRIMARY KEY (job_id, section_key, ordinal),
  CONSTRAINT insights_job_page_rows_job_fk FOREIGN KEY (job_id)
    REFERENCES private_hot_updater_insights_jobs(id)
    ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT insights_job_page_rows_number_check CHECK (
    ordinal >= 0 AND filter_ordinal >= 0
    AND row_bytes >= 1 AND row_bytes <= 1048576
  )
);

CREATE INDEX private_hot_updater_insights_job_page_filter_idx
  ON private_hot_updater_insights_job_page_rows(
    job_id, section_key, filter_label, filter_ordinal
  );

CREATE TABLE private_hot_updater_insights_job_sections (
  job_id TEXT NOT NULL,
  section_key TEXT NOT NULL,
  total_rows INTEGER NOT NULL,
  PRIMARY KEY (job_id, section_key),
  CONSTRAINT insights_job_sections_job_fk FOREIGN KEY (job_id)
    REFERENCES private_hot_updater_insights_jobs(id)
    ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT insights_job_sections_total_check CHECK (total_rows >= 0)
);

CREATE TRIGGER insights_job_latest_install_key_collision
BEFORE INSERT ON private_hot_updater_insights_job_latest
WHEN EXISTS (
  SELECT 1 FROM private_hot_updater_insights_job_latest
  WHERE job_id = NEW.job_id AND install_key = NEW.install_key
    AND install_id <> NEW.install_id
)
BEGIN
  SELECT RAISE(ABORT, 'HOT_UPDATER_INSIGHTS_JOB_INSTALL_KEY_COLLISION');
END;

CREATE TRIGGER insights_job_membership_count_collision
BEFORE INSERT ON private_hot_updater_insights_job_memberships
WHEN EXISTS (
  SELECT 1 FROM private_hot_updater_insights_job_counts
  WHERE job_id = NEW.job_id AND count_key = NEW.count_key
    AND (
      section <> NEW.section OR metric <> NEW.metric OR label <> NEW.label
      OR bucket_start_ms <> NEW.bucket_start_ms
    )
)
BEGIN
  SELECT RAISE(ABORT, 'HOT_UPDATER_INSIGHTS_JOB_COUNT_COLLISION');
END;

CREATE TRIGGER insights_job_membership_install_key_collision
BEFORE INSERT ON private_hot_updater_insights_job_memberships
WHEN EXISTS (
  SELECT 1 FROM private_hot_updater_insights_job_memberships
  WHERE job_id = NEW.job_id AND install_key = NEW.install_key
    AND install_id <> NEW.install_id
)
BEGIN
  SELECT RAISE(ABORT, 'HOT_UPDATER_INSIGHTS_JOB_INSTALL_KEY_COLLISION');
END;

CREATE TRIGGER insights_job_membership_count
AFTER INSERT ON private_hot_updater_insights_job_memberships
BEGIN
  INSERT INTO private_hot_updater_insights_job_counts (
    job_id, count_key, section, metric, label, bucket_start_ms, value
  ) VALUES (
    NEW.job_id, NEW.count_key, NEW.section, NEW.metric, NEW.label,
    NEW.bucket_start_ms, 1
  )
  ON CONFLICT(job_id, count_key) DO UPDATE SET value = value + 1;
END;
