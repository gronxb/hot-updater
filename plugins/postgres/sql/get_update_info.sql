-- HotUpdater.get_update_info

CREATE OR REPLACE FUNCTION get_update_info (
    app_platform   platforms,
    app_version text,
    bundle_id  uuid
)
RETURNS TABLE (
    id            uuid,
    should_force_update  boolean,
    file_url      text,
    file_hash     text,
    status        text
)
LANGUAGE plpgsql
AS
$$
DECLARE
    NIL_UUID CONSTANT uuid := '00000000-0000-0000-0000-000000000000';
BEGIN
    RETURN QUERY
    WITH rollback_candidate AS (
        SELECT
            b.id,
            TRUE AS should_force_update,
            b.file_url,
            b.file_hash,
            'ROLLBACK' AS status
        FROM bundles b
        WHERE b.enabled = TRUE
          AND b.platform = app_platform
          AND b.id < bundle_id
          -- Do not apply rollback candidates when bundle_id is NIL_UUID or when it's a build-time bundle (non-NIL_UUID with last part being 000000000000)
          AND (bundle_id != NIL_UUID AND bundle_id::text NOT LIKE '%000000000000')
        ORDER BY b.id DESC
        LIMIT 1
    ),
    update_candidate AS (
        SELECT
            b.id,
            b.should_force_update,
            b.file_url,
            b.file_hash,
            'UPDATE' AS status
        FROM bundles b
        WHERE b.enabled = TRUE
          AND b.platform = app_platform
          AND b.id >= bundle_id
          AND semver_satisfies(b.target_app_version, app_version)
          AND (
              -- For build-time bundles (when bundle_id is not NIL_UUID)
              (bundle_id != NIL_UUID AND bundle_id::text LIKE '%000000000000'
                AND substring(b.id::text from '^(.*)-') > substring(bundle_id::text from '^(.*)-'))
              OR
              -- For other cases (regular bundles or when bundle_id is NIL_UUID)
              (bundle_id = NIL_UUID OR bundle_id::text NOT LIKE '%000000000000')
          )
        ORDER BY b.id DESC
        LIMIT 1
    ),
    final_result AS (
        SELECT *
        FROM update_candidate
        UNION ALL
        SELECT *
        FROM rollback_candidate
        WHERE NOT EXISTS (SELECT 1 FROM update_candidate)
    )
    SELECT *
    FROM final_result
    WHERE final_result.id != bundle_id

    UNION ALL
    /* fallback:
       when there are no candidates, but don't apply fallback if bundle_id is NIL_UUID or build-time */
    SELECT
        NIL_UUID      AS id,
        TRUE          AS should_force_update,
        NULL          AS file_url,
        NULL          AS file_hash,
        'ROLLBACK'    AS status
    WHERE (SELECT COUNT(*) FROM final_result) = 0
      AND bundle_id != NIL_UUID
      AND bundle_id::text NOT LIKE '%000000000000';

END;
$$;