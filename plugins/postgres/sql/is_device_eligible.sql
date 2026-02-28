-- Eligibility check matching JavaScript logic
-- Determines if a device is eligible for an update based on rollout settings
-- Priority: targetDeviceIds > percentage-based rollout
CREATE OR REPLACE FUNCTION is_device_eligible(
  device_id TEXT,
  rollout_percentage INTEGER,
  target_device_ids TEXT[]
)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
  -- Priority 1: targetDeviceIds
  IF target_device_ids IS NOT NULL AND array_length(target_device_ids, 1) > 0 THEN
    RETURN device_id = ANY(target_device_ids);
  END IF;

  -- Priority 2: rolloutPercentage
  IF rollout_percentage IS NULL OR rollout_percentage >= 100 THEN
    RETURN TRUE;
  END IF;

  IF rollout_percentage <= 0 THEN
    RETURN FALSE;
  END IF;

  -- Hash-based eligibility
  RETURN hash_user_id(device_id) < rollout_percentage;
END;
$$;
