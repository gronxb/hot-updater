CREATE TABLE IF NOT EXISTS bundle_events (
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
  CONSTRAINT bundle_events_type_check
    CHECK (type IN ('UPDATE_APPLIED', 'RECOVERED', 'UNCHANGED')),
  CONSTRAINT bundle_events_platform_check
    CHECK (platform IN ('ios', 'android')),
  CONSTRAINT bundle_events_shape_check CHECK (
    (
      type IN ('UPDATE_APPLIED', 'RECOVERED')
      AND from_bundle_id IS NOT NULL
      AND update_strategy IN ('fingerprint', 'appVersion')
    ) OR (
      type = 'UNCHANGED'
      AND from_bundle_id IS NULL
      AND update_strategy IS NULL
    )
  ),
  CONSTRAINT bundle_events_received_at_check CHECK (received_at_ms >= 0)
);

CREATE TABLE IF NOT EXISTS client_access_keys (
  id TEXT PRIMARY KEY NOT NULL,
  hash TEXT NOT NULL,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  role TEXT NOT NULL,
  created_at_ms REAL NOT NULL,
  revoked_at_ms REAL,
  CONSTRAINT client_access_keys_role_check CHECK (role = 'client'),
  CONSTRAINT client_access_keys_created_at_check CHECK (created_at_ms >= 0),
  CONSTRAINT client_access_keys_revoked_at_check
    CHECK (revoked_at_ms IS NULL OR revoked_at_ms >= 0)
);

CREATE INDEX IF NOT EXISTS bundle_events_received_at_idx
  ON bundle_events(received_at_ms, id);
CREATE INDEX IF NOT EXISTS bundle_events_install_idx
  ON bundle_events(install_id, received_at_ms, id);
CREATE INDEX IF NOT EXISTS bundle_events_user_id_idx
  ON bundle_events(user_id, received_at_ms, id);
CREATE INDEX IF NOT EXISTS bundle_events_username_idx
  ON bundle_events(username, received_at_ms, id);
CREATE INDEX IF NOT EXISTS bundle_events_to_bundle_idx
  ON bundle_events(type, to_bundle_id, received_at_ms, id);
CREATE INDEX IF NOT EXISTS bundle_events_from_bundle_idx
  ON bundle_events(type, from_bundle_id, received_at_ms, id);
CREATE UNIQUE INDEX IF NOT EXISTS client_access_keys_hash_key
  ON client_access_keys(hash);
CREATE INDEX IF NOT EXISTS client_access_keys_created_at_idx
  ON client_access_keys(created_at_ms, id);

INSERT INTO private_hot_updater_settings (key, value)
VALUES ('schema.core', '0.37.0')
ON CONFLICT(key) DO UPDATE SET value = CASE
  WHEN private_hot_updater_settings.value IN ('0.36.0', '0.37.0')
    THEN excluded.value
  ELSE NULL
END;
