-- HotUpdater.is_cohort_eligible
CREATE OR REPLACE FUNCTION is_cohort_eligible(
  bundle_id UUID,
  cohort TEXT,
  rollout_cohort_count INTEGER,
  target_cohorts TEXT[]
)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  normalized_cohort TEXT := normalize_cohort_value(cohort);
  normalized_rollout_count INTEGER := COALESCE(rollout_cohort_count, 1000);
  normalized_target_cohorts TEXT[];
BEGIN
  IF target_cohorts IS NOT NULL THEN
    normalized_target_cohorts := ARRAY(
      SELECT normalize_cohort_value(value)
      FROM unnest(target_cohorts) AS value
    );
  END IF;

  IF normalized_target_cohorts IS NOT NULL
     AND array_length(normalized_target_cohorts, 1) > 0
     AND normalized_cohort IS NOT NULL
     AND normalized_cohort = ANY(normalized_target_cohorts) THEN
    RETURN TRUE;
  END IF;

  IF normalized_rollout_count <= 0 THEN
    RETURN FALSE;
  END IF;

  IF normalized_cohort IS NULL THEN
    RETURN normalized_rollout_count >= 1000;
  END IF;

  IF NOT is_numeric_cohort(normalized_cohort) THEN
    RETURN FALSE;
  END IF;

  IF normalized_rollout_count >= 1000 THEN
    RETURN TRUE;
  END IF;

  RETURN get_numeric_cohort_rollout_position(bundle_id, normalized_cohort)
    < normalized_rollout_count;
END;
$$;
