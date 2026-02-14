-- Add rollout eligibility functions for query-time filtering
-- This migration adds SQL functions for hash calculation and device eligibility checking

-- Deterministic hash function matching JavaScript implementation
-- Returns hash value in range [0, 99]
CREATE OR REPLACE FUNCTION hash_user_id(user_id TEXT)
RETURNS INTEGER
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  hash BIGINT := 0;
  char_code INTEGER;
  i INTEGER;
BEGIN
  -- Replicate JavaScript hash algorithm
  FOR i IN 1..length(user_id) LOOP
    char_code := ascii(substring(user_id from i for 1));
    hash := ((hash << 5) - hash + char_code)::BIGINT;
    -- Simulate JavaScript's |= 0 (convert to 32-bit int)
    hash := (hash % 4294967296)::INTEGER;
  END LOOP;

  -- Return absolute value modulo 100
  RETURN abs(hash % 100);
END;
$$;

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
