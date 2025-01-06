--HotUpdater.get_update_info
CREATE OR REPLACE FUNCTION get_update_info (
    app_platform   platforms,
    app_version text,
    bundle_id  uuid
)
RETURNS TABLE (
    id            uuid,
    force_update  boolean,
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
            -- If status is 'ROLLBACK', force_update is always TRUE
            TRUE AS force_update,
            b.file_url,
            b.file_hash,
            'ROLLBACK' AS status
        FROM bundles b
        WHERE b.enabled = TRUE
          AND b.platform = app_platform
          AND b.id < bundle_id
        ORDER BY b.id DESC
        LIMIT 1
    ),
    update_candidate AS (
        SELECT
            b.id,
            b.force_update,
            b.file_url,
            b.file_hash,
            'UPDATE' AS status
        FROM bundles b
        WHERE b.enabled = TRUE
          AND b.platform = app_platform
          AND b.id >= bundle_id
          AND semver_satisfies(b.target_app_version, app_version)
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
    FROM final_result WHERE final_result.id != bundle_id

    UNION ALL
    /*
      When there are no final results and bundle_id != NIL_UUID,
      add one fallback row.
      This fallback row is also ROLLBACK so forceUpdate = TRUE.
    */
    SELECT
        NIL_UUID      AS id,
        TRUE          AS force_update,  -- Always TRUE
        NULL          AS file_url,
        NULL          AS file_hash,
        'ROLLBACK'    AS status
    WHERE (SELECT COUNT(*) FROM final_result) = 0
      AND bundle_id != NIL_UUID;

END;
$$;