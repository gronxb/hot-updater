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
  normalized BIGINT;
BEGIN
  -- Replicate JavaScript hash algorithm
  FOR i IN 1..length(user_id) LOOP
    char_code := ascii(substring(user_id from i for 1));
    hash := (hash * 31) + char_code;

    -- Simulate JavaScript's |= 0 by wrapping into a signed 32-bit range.
    normalized := mod(hash + 2147483648, 4294967296);
    IF normalized < 0 THEN
      normalized := normalized + 4294967296;
    END IF;
    hash := normalized - 2147483648;
  END LOOP;

  -- Return absolute value modulo 100
  RETURN abs(hash % 100);
END;
$$;
