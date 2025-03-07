-- HotUpdater.get_update_info

CREATE OR REPLACE FUNCTION get_update_info (
    app_platform   platforms,
    app_version text,
    bundle_id  uuid,
    min_bundle_id uuid
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
    WITH update_candidate AS (
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
          AND b.id > min_bundle_id
          AND semver_satisfies(b.target_app_version, app_version)
        ORDER BY b.id DESC
        LIMIT 1
    ),
    rollback_candidate AS (
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
          AND b.id > min_bundle_id
        ORDER BY b.id DESC
        LIMIT 1
    ),
    final_result AS (
        SELECT * FROM update_candidate
        UNION ALL
        SELECT * FROM rollback_candidate
        WHERE NOT EXISTS (SELECT 1 FROM update_candidate)
    )
    SELECT *
    FROM final_result
    WHERE final_result.id != bundle_id

    UNION ALL

    -- fallback: 번들 DB에 현재(bundle_id)가 없고,
    --          (단, bundle_id가 min_bundle_id와 같으면 아무것도 하지 않고, bundle_id가 min_bundle_id보다 큰 경우에만 fallback)
    SELECT
        NIL_UUID      AS id,
        TRUE          AS should_force_update,
        NULL          AS file_url,
        NULL          AS file_hash,
        'ROLLBACK'    AS status
    WHERE (SELECT COUNT(*) FROM final_result) = 0
      AND bundle_id != NIL_UUID
      AND bundle_id > min_bundle_id
      AND NOT EXISTS (
          SELECT 1
          FROM bundles b
          WHERE b.id = bundle_id
            AND b.enabled = TRUE
            AND b.platform = app_platform
      );
END;
$$;