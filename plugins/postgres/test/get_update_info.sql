
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
BEGIN
    RETURN QUERY
    WITH rollback_candidate AS (
        SELECT
            b.id,
            b.force_update,
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
          AND semver_satisfies(b.target_version, current_app_version)
        ORDER BY b.id DESC
        LIMIT 1
    )
    SELECT *
    FROM rollback_candidate

    UNION ALL

    SELECT *
    FROM update_candidate
    WHERE NOT EXISTS (SELECT 1 FROM rollback_candidate);
END;
$$;