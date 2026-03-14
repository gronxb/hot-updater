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
