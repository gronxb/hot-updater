-- Migration number: 0004 	 2025-12-21T00:00:00.000Z

-- HotUpdater.bundles

ALTER TABLE bundles ADD COLUMN rollout_cohort_count INTEGER DEFAULT 1000
  CHECK (rollout_cohort_count >= 0 AND rollout_cohort_count <= 1000);

CREATE INDEX IF NOT EXISTS bundles_rollout_idx ON bundles(rollout_cohort_count);

-- SQLite doesn't have array type, store as JSON text
ALTER TABLE bundles ADD COLUMN target_cohorts TEXT;
