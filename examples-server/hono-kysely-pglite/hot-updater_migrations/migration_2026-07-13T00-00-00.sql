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

INSERT INTO
  private_hot_updater_settings (key, value)
VALUES
  ('version', '0.38.0')
ON CONFLICT (key) DO UPDATE
SET
  value = '0.38.0';
