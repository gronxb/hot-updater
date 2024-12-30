CREATE OR REPLACE FUNCTION get_update_info (
    current_platform   platforms,
    current_bundle_id  uuid,
    current_app_version text
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
            -- status가 'ROLLBACK'이면 force_update는 무조건 TRUE
            TRUE AS force_update,
            b.file_url,
            b.file_hash,
            'ROLLBACK' AS status
        FROM bundles b
        WHERE b.enabled = TRUE
          AND b.platform = current_platform
          AND b.id < current_bundle_id
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
          AND b.platform = current_platform
          AND b.id >= current_bundle_id
          AND semver_satisfies(b.target_version, current_app_version)
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

    UNION ALL
    /*
      최종 결과가 0개이고, current_bundle_id != NIL_UUID일 때
      fallback row를 1개 추가.
      이 fallback row도 ROLLBACK 이므로 forceUpdate = TRUE.
    */
    SELECT
        NIL_UUID      AS id,
        TRUE          AS force_update,  -- 무조건 TRUE
        NULL          AS file_url,
        NULL          AS file_hash,
        'ROLLBACK'    AS status
    WHERE (SELECT COUNT(*) FROM final_result) = 0
      AND current_bundle_id != NIL_UUID;

END;
$$;