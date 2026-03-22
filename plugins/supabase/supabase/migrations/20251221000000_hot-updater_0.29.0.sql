-- HotUpdater.bundles

ALTER TABLE bundles
  ADD COLUMN IF NOT EXISTS rollout_cohort_count INTEGER DEFAULT 1000
    CHECK (rollout_cohort_count >= 0 AND rollout_cohort_count <= 1000);

CREATE INDEX IF NOT EXISTS bundles_rollout_idx ON bundles(rollout_cohort_count);

ALTER TABLE bundles
  ADD COLUMN IF NOT EXISTS target_cohorts TEXT[];

CREATE INDEX IF NOT EXISTS bundles_target_cohorts_idx ON bundles
  USING GIN (target_cohorts);
