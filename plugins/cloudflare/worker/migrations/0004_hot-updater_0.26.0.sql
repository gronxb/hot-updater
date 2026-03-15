-- Migration number: 0004 	 2025-12-21T00:00:00.000Z

-- HotUpdater.bundles

ALTER TABLE bundles ADD COLUMN rollout_percentage INTEGER DEFAULT 100
  CHECK (rollout_percentage >= 0 AND rollout_percentage <= 100);

CREATE INDEX IF NOT EXISTS bundles_rollout_idx ON bundles(rollout_percentage);

-- SQLite doesn't have array type, store as JSON text
ALTER TABLE bundles ADD COLUMN target_device_ids TEXT;
