BEGIN;

CREATE TABLE IF NOT EXISTS public.channels (
  id text PRIMARY KEY,
  name text NOT NULL UNIQUE
);

INSERT INTO public.channels (id, name)
SELECT DISTINCT b.channel, b.channel
FROM public.bundles b
WHERE NOT EXISTS (
  SELECT 1 FROM public.channels c WHERE c.name = b.channel
)
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;

ALTER TABLE public.bundles
  ADD COLUMN channel_id text;

UPDATE public.bundles b
SET channel_id = c.id
FROM public.channels c
WHERE c.name = b.channel;

ALTER TABLE public.bundles
  ALTER COLUMN channel_id SET NOT NULL,
  ADD CONSTRAINT bundles_channel_id_fk
  FOREIGN KEY (channel_id)
  REFERENCES public.channels(id) ON DELETE RESTRICT;

CREATE INDEX bundles_channel_id_idx ON public.bundles(channel_id);

ALTER TABLE public.channels ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.get_channels ()
RETURNS TABLE (
    channel text
)
LANGUAGE sql
STABLE
SET search_path = public, pg_catalog
AS
$$
    SELECT c.name AS channel
    FROM public.channels c
    ORDER BY c.name
$$;

CREATE OR REPLACE FUNCTION public.get_update_info_by_fingerprint_hash (
    app_platform   public.platforms,
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
SET search_path = public, pg_catalog
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
        FROM public.bundles b
        JOIN public.channels c ON c.id = b.channel_id
        WHERE b.enabled = TRUE
          AND b.platform = app_platform
          AND b.id >= min_bundle_id
          AND c.name = target_channel
          AND b.fingerprint_hash = target_fingerprint_hash
    ),
    current_candidate AS (
        SELECT
            cb.id,
            public.is_cohort_eligible(
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
          AND public.is_cohort_eligible(
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

CREATE OR REPLACE FUNCTION public.get_update_info_by_app_version (
    app_platform   public.platforms,
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
SET search_path = public, pg_catalog
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
        FROM public.bundles b
        JOIN public.channels c ON c.id = b.channel_id
        WHERE b.enabled = TRUE
          AND b.platform = app_platform
          AND b.id >= min_bundle_id
          AND b.target_app_version IN (
              SELECT pg_catalog.unnest(target_app_version_list)
          )
          AND c.name = target_channel
    ),
    current_candidate AS (
        SELECT
            cb.id,
            public.is_cohort_eligible(
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
          AND public.is_cohort_eligible(
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

COMMIT;
