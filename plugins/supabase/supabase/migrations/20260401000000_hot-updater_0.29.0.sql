-- HotUpdater.bundles

ALTER TABLE bundles
  ADD COLUMN IF NOT EXISTS rollout_cohort_count INTEGER DEFAULT 1000
    CHECK (rollout_cohort_count >= 0 AND rollout_cohort_count <= 1000);

CREATE INDEX IF NOT EXISTS bundles_rollout_idx ON bundles(rollout_cohort_count);

ALTER TABLE bundles
  ADD COLUMN IF NOT EXISTS target_cohorts TEXT[];

CREATE INDEX IF NOT EXISTS bundles_target_cohorts_idx ON bundles
  USING GIN (target_cohorts);

-- HotUpdater.is_cohort_eligible
-- Cohort eligibility helpers matching @hot-updater/core rollout.ts

CREATE OR REPLACE FUNCTION positive_mod(
  value INTEGER,
  modulus INTEGER
)
RETURNS INTEGER
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
  RETURN ((value % modulus) + modulus) % modulus;
END;
$$;

CREATE OR REPLACE FUNCTION hash_rollout_value(input TEXT)
RETURNS INTEGER
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  hash_value NUMERIC := 0;
  char_code INTEGER;
  i INTEGER;
BEGIN
  FOR i IN 1..length(input) LOOP
    char_code := ascii(substring(input from i for 1));
    hash_value := mod((hash_value * 31) + char_code, 4294967296);
  END LOOP;

  IF hash_value >= 2147483648 THEN
    hash_value := hash_value - 4294967296;
  END IF;

  RETURN hash_value::INTEGER;
END;
$$;

CREATE OR REPLACE FUNCTION normalize_cohort_value(cohort TEXT)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  normalized TEXT;
  cohort_value INTEGER;
BEGIN
  IF cohort IS NULL THEN
    RETURN NULL;
  END IF;

  normalized := lower(btrim(cohort));

  IF normalized ~ '^[0-9]+$' THEN
    cohort_value := normalized::INTEGER;
    IF cohort_value BETWEEN 1 AND 1000 THEN
      RETURN cohort_value::TEXT;
    END IF;
  END IF;

  RETURN normalized;
END;
$$;

CREATE OR REPLACE FUNCTION gcd_int(a INTEGER, b INTEGER)
RETURNS INTEGER
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  x INTEGER := abs(a);
  y INTEGER := abs(b);
  next_value INTEGER;
BEGIN
  WHILE y <> 0 LOOP
    next_value := x % y;
    x := y;
    y := next_value;
  END LOOP;

  RETURN x;
END;
$$;

CREATE OR REPLACE FUNCTION get_rollout_multiplier(bundle_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  candidate INTEGER := positive_mod(
    hash_rollout_value(bundle_id::TEXT || ':multiplier'),
    997
  );
BEGIN
  IF candidate = 0 THEN
    candidate := 1;
  END IF;

  WHILE gcd_int(candidate, 1000) <> 1 LOOP
    candidate := positive_mod(candidate + 1, 1000);
    IF candidate = 0 THEN
      candidate := 1;
    END IF;
  END LOOP;

  RETURN candidate;
END;
$$;

CREATE OR REPLACE FUNCTION get_rollout_offset(bundle_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
  RETURN positive_mod(hash_rollout_value(bundle_id::TEXT || ':offset'), 1000);
END;
$$;

CREATE OR REPLACE FUNCTION get_modular_inverse(value INTEGER, modulus INTEGER)
RETURNS INTEGER
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  candidate INTEGER;
BEGIN
  FOR candidate IN 1..(modulus - 1) LOOP
    IF positive_mod(value * candidate, modulus) = 1 THEN
      RETURN candidate;
    END IF;
  END LOOP;

  RAISE EXCEPTION 'No modular inverse for % mod %', value, modulus;
END;
$$;

CREATE OR REPLACE FUNCTION is_numeric_cohort(cohort TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  normalized_cohort TEXT := normalize_cohort_value(cohort);
  cohort_value INTEGER;
BEGIN
  IF normalized_cohort IS NULL OR normalized_cohort !~ '^[0-9]+$' THEN
    RETURN FALSE;
  END IF;

  cohort_value := normalized_cohort::INTEGER;
  RETURN cohort_value BETWEEN 1 AND 1000;
END;
$$;

CREATE OR REPLACE FUNCTION get_numeric_cohort_rollout_position(
  bundle_id UUID,
  cohort TEXT
)
RETURNS INTEGER
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  normalized_cohort TEXT := normalize_cohort_value(cohort);
  cohort_value INTEGER;
  multiplier INTEGER;
  offset_value INTEGER;
  inverse_multiplier INTEGER;
BEGIN
  IF NOT is_numeric_cohort(normalized_cohort) THEN
    RAISE EXCEPTION 'Invalid numeric cohort: %', cohort;
  END IF;

  cohort_value := normalized_cohort::INTEGER - 1;
  multiplier := get_rollout_multiplier(bundle_id);
  offset_value := get_rollout_offset(bundle_id);
  inverse_multiplier := get_modular_inverse(multiplier, 1000);

  RETURN positive_mod(
    inverse_multiplier * (cohort_value - offset_value),
    1000
  );
END;
$$;

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

-- HotUpdater.get_update_info_by_fingerprint_hash

DROP FUNCTION IF EXISTS get_update_info_by_fingerprint_hash;

CREATE OR REPLACE FUNCTION get_update_info_by_fingerprint_hash (
    app_platform   platforms,
    bundle_id  uuid,
    min_bundle_id uuid,
    target_channel text,
    target_fingerprint_hash text,
    cohort TEXT DEFAULT NULL
)
RETURNS TABLE (
    id            uuid,
    should_force_update  boolean,
    message       text,
    status        text,
    storage_uri   text,
    file_hash     text
)
LANGUAGE plpgsql
AS
$$
DECLARE
    NIL_UUID CONSTANT uuid := '00000000-0000-0000-0000-000000000000';
BEGIN
    RETURN QUERY
    WITH candidate_bundles AS (
        SELECT
            b.id,
            b.should_force_update,
            b.message,
            b.storage_uri,
            b.file_hash,
            b.rollout_cohort_count,
            b.target_cohorts
        FROM bundles b
        WHERE b.enabled = TRUE
          AND b.platform = app_platform
          AND b.id >= min_bundle_id
          AND b.channel = target_channel
          AND b.fingerprint_hash = target_fingerprint_hash
    ),
    current_candidate AS (
        SELECT
            cb.id,
            is_cohort_eligible(
                cb.id,
                cohort,
                cb.rollout_cohort_count,
                cb.target_cohorts
            ) AS is_eligible
        FROM candidate_bundles cb
        WHERE cb.id = bundle_id
        LIMIT 1
    ),
    eligible_update_candidate AS (
        SELECT
            cb.id,
            cb.should_force_update,
            cb.message,
            'UPDATE' AS status,
            cb.storage_uri,
            cb.file_hash
        FROM candidate_bundles cb
        WHERE cb.id > bundle_id
          AND is_cohort_eligible(
              cb.id,
              cohort,
              cb.rollout_cohort_count,
              cb.target_cohorts
          )
        ORDER BY cb.id DESC
        LIMIT 1
    ),
    rollback_candidate AS (
        SELECT
            cb.id,
            TRUE AS should_force_update,
            cb.message,
            'ROLLBACK' AS status,
            cb.storage_uri,
            cb.file_hash
        FROM candidate_bundles cb
        WHERE cb.id < bundle_id
          AND NOT EXISTS (
              SELECT 1
              FROM current_candidate
              WHERE current_candidate.is_eligible = TRUE
          )
          AND NOT EXISTS (SELECT 1 FROM eligible_update_candidate)
        ORDER BY cb.id DESC
        LIMIT 1
    ),
    final_result AS (
        SELECT * FROM eligible_update_candidate
        UNION ALL
        SELECT * FROM rollback_candidate
        WHERE NOT EXISTS (SELECT 1 FROM eligible_update_candidate)
    )
    SELECT *
    FROM final_result
    WHERE final_result.id != bundle_id

    UNION ALL

    SELECT
        NIL_UUID      AS id,
        TRUE          AS should_force_update,
        NULL          AS message,
        'ROLLBACK'    AS status,
        NULL          AS storage_uri,
        NULL          AS file_hash
    WHERE (SELECT COUNT(*) FROM final_result) = 0
      AND bundle_id != NIL_UUID
      AND bundle_id > min_bundle_id
      AND NOT EXISTS (
          SELECT 1
          FROM current_candidate
          WHERE current_candidate.is_eligible = TRUE
      )
      AND NOT EXISTS (SELECT 1 FROM eligible_update_candidate)
      AND NOT EXISTS (SELECT 1 FROM rollback_candidate);
END;
$$;

-- HotUpdater.get_update_info_by_app_version

DROP FUNCTION IF EXISTS get_update_info_by_app_version;

CREATE OR REPLACE FUNCTION get_update_info_by_app_version (
    app_platform   platforms,
    app_version text,
    bundle_id  uuid,
    min_bundle_id uuid,
    target_channel text,
    target_app_version_list text[],
    cohort TEXT DEFAULT NULL
)
RETURNS TABLE (
    id            uuid,
    should_force_update  boolean,
    message       text,
    status        text,
    storage_uri   text,
    file_hash     text
)
LANGUAGE plpgsql
AS
$$
DECLARE
    NIL_UUID CONSTANT uuid := '00000000-0000-0000-0000-000000000000';
BEGIN
    RETURN QUERY
    WITH candidate_bundles AS (
        SELECT
            b.id,
            b.should_force_update,
            b.message,
            b.storage_uri,
            b.file_hash,
            b.rollout_cohort_count,
            b.target_cohorts
        FROM bundles b
        WHERE b.enabled = TRUE
          AND b.platform = app_platform
          AND b.id >= min_bundle_id
          AND b.target_app_version IN (SELECT unnest(target_app_version_list))
          AND b.channel = target_channel
    ),
    current_candidate AS (
        SELECT
            cb.id,
            is_cohort_eligible(
                cb.id,
                cohort,
                cb.rollout_cohort_count,
                cb.target_cohorts
            ) AS is_eligible
        FROM candidate_bundles cb
        WHERE cb.id = bundle_id
        LIMIT 1
    ),
    eligible_update_candidate AS (
        SELECT
            cb.id,
            cb.should_force_update,
            cb.message,
            'UPDATE' AS status,
            cb.storage_uri,
            cb.file_hash
        FROM candidate_bundles cb
        WHERE cb.id > bundle_id
          AND is_cohort_eligible(
              cb.id,
              cohort,
              cb.rollout_cohort_count,
              cb.target_cohorts
          )
        ORDER BY cb.id DESC
        LIMIT 1
    ),
    rollback_candidate AS (
        SELECT
            cb.id,
            TRUE AS should_force_update,
            cb.message,
            'ROLLBACK' AS status,
            cb.storage_uri,
            cb.file_hash
        FROM candidate_bundles cb
        WHERE cb.id < bundle_id
          AND NOT EXISTS (
              SELECT 1
              FROM current_candidate
              WHERE current_candidate.is_eligible = TRUE
          )
          AND NOT EXISTS (SELECT 1 FROM eligible_update_candidate)
        ORDER BY cb.id DESC
        LIMIT 1
    ),
    final_result AS (
        SELECT * FROM eligible_update_candidate
        UNION ALL
        SELECT * FROM rollback_candidate
        WHERE NOT EXISTS (SELECT 1 FROM eligible_update_candidate)
    )
    SELECT *
    FROM final_result
    WHERE final_result.id != bundle_id

    UNION ALL

    SELECT
        NIL_UUID      AS id,
        TRUE          AS should_force_update,
        NULL          AS message,
        'ROLLBACK'    AS status,
        NULL          AS storage_uri,
        NULL          AS file_hash
    WHERE (SELECT COUNT(*) FROM final_result) = 0
      AND bundle_id != NIL_UUID
      AND bundle_id > min_bundle_id
      AND NOT EXISTS (
          SELECT 1
          FROM current_candidate
          WHERE current_candidate.is_eligible = TRUE
      )
      AND NOT EXISTS (SELECT 1 FROM eligible_update_candidate)
      AND NOT EXISTS (SELECT 1 FROM rollback_candidate);
END;
$$;
