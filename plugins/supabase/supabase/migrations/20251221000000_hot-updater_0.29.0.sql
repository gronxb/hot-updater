-- HotUpdater.bundles

ALTER TABLE bundles
  ADD COLUMN IF NOT EXISTS rollout_percentage INTEGER DEFAULT 100
    CHECK (rollout_percentage >= 0 AND rollout_percentage <= 100);

CREATE INDEX IF NOT EXISTS bundles_rollout_idx ON bundles(rollout_percentage);

ALTER TABLE bundles
  ADD COLUMN IF NOT EXISTS target_device_ids TEXT[];

CREATE INDEX IF NOT EXISTS bundles_target_device_ids_idx ON bundles
  USING GIN (target_device_ids);
