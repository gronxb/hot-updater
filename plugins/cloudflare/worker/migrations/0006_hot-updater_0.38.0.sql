CREATE TABLE bundle_channels (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE
);

INSERT INTO bundle_channels (id, name)
SELECT DISTINCT channel, channel FROM bundles;

ALTER TABLE bundles
ADD COLUMN channel_id TEXT REFERENCES bundle_channels(id) ON DELETE RESTRICT;

UPDATE bundles
SET channel_id = COALESCE(
    (SELECT bundle_channels.id FROM bundle_channels WHERE bundle_channels.name = bundles.channel),
    bundles.channel
);

CREATE TRIGGER bundles_channel_id_not_null_insert
BEFORE INSERT ON bundles
WHEN NEW.channel_id IS NULL
BEGIN
    SELECT RAISE(ABORT, 'bundles.channel_id must not be null');
END;

CREATE TRIGGER bundles_channel_id_not_null_update
BEFORE UPDATE OF channel_id ON bundles
WHEN NEW.channel_id IS NULL
BEGIN
    SELECT RAISE(ABORT, 'bundles.channel_id must not be null');
END;

CREATE INDEX bundles_channel_id_idx ON bundles(channel_id);

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
