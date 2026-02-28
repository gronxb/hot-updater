-- Migration number: 0004 	 2025-12-21T00:00:00.000Z

-- HotUpdater.bundles

ALTER TABLE bundles ADD COLUMN rollout_percentage INTEGER DEFAULT 100
  CHECK (rollout_percentage >= 0 AND rollout_percentage <= 100);

CREATE INDEX IF NOT EXISTS bundles_rollout_idx ON bundles(rollout_percentage);

-- SQLite doesn't have array type, store as JSON text
ALTER TABLE bundles ADD COLUMN target_device_ids TEXT;

-- HotUpdater.device_events

CREATE TABLE IF NOT EXISTS device_events (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  bundle_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('PROMOTED', 'RECOVERED')),
  platform TEXT NOT NULL CHECK (platform IN ('ios', 'android')),
  app_version TEXT,
  channel TEXT NOT NULL,
  metadata TEXT DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS device_events_device_id_idx ON device_events(device_id);
CREATE INDEX IF NOT EXISTS device_events_bundle_id_idx ON device_events(bundle_id);
CREATE INDEX IF NOT EXISTS device_events_id_idx ON device_events(id DESC);

