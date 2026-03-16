DROP FUNCTION IF EXISTS get_update_info_by_fingerprint_hash;
DROP FUNCTION IF EXISTS get_update_info_by_app_version;

-- HotUpdater.get_update_info_by_fingerprint_hash
CREATE OR REPLACE FUNCTION get_update_info_by_fingerprint_hash (
    app_platform   platforms,
    masked_bundle_id_lower uuid,
    masked_bundle_id_upper uuid,
    min_bundle_id uuid,
    target_channel text,
    target_fingerprint_hash text
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
    WITH update_candidate AS (
        SELECT
            b.id,
            b.should_force_update,
            b.message,
            'UPDATE' AS status,
            b.storage_uri,
            b.file_hash
        FROM bundles b
        WHERE b.enabled = TRUE
          AND b.platform = app_platform
          AND b.id >= masked_bundle_id_lower
          AND b.id > min_bundle_id
          AND b.channel = target_channel
          AND b.fingerprint_hash = target_fingerprint_hash
        ORDER BY b.id DESC
        LIMIT 1
    ),
    rollback_candidate AS (
        SELECT
            b.id,
            TRUE AS should_force_update,
            b.message,
            'ROLLBACK' AS status,
            b.storage_uri,
            b.file_hash
        FROM bundles b
        WHERE b.enabled = TRUE
          AND b.platform = app_platform
          AND b.id < masked_bundle_id_lower
          AND b.id > min_bundle_id
          AND b.channel = target_channel
          AND b.fingerprint_hash = target_fingerprint_hash
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
    WHERE NOT (final_result.id BETWEEN masked_bundle_id_lower AND masked_bundle_id_upper)

    UNION ALL

    SELECT
        NIL_UUID      AS id,
        TRUE          AS should_force_update,
        NULL          AS message,
        'ROLLBACK'    AS status,
        NULL          AS storage_uri,
        NULL          AS file_hash
    WHERE (SELECT COUNT(*) FROM final_result) = 0
      AND masked_bundle_id_lower != NIL_UUID
      AND masked_bundle_id_lower > min_bundle_id
      AND NOT EXISTS (
          SELECT 1
          FROM bundles b
          WHERE b.id BETWEEN masked_bundle_id_lower AND masked_bundle_id_upper
            AND b.enabled = TRUE
            AND b.platform = app_platform
      );
END;
$$;


-- HotUpdater.get_update_info_by_app_version
CREATE OR REPLACE FUNCTION get_update_info_by_app_version (
    app_platform   platforms,
    app_version text,
    masked_bundle_id_lower uuid,
    masked_bundle_id_upper uuid,
    min_bundle_id uuid,
    target_channel text,
    target_app_version_list text[]
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
    WITH update_candidate AS (
        SELECT
            b.id,
            b.should_force_update,
            b.message,
            'UPDATE' AS status,
            b.storage_uri,
            b.file_hash
        FROM bundles b
        WHERE b.enabled = TRUE
          AND b.platform = app_platform
          AND b.id >= masked_bundle_id_lower
          AND b.id > min_bundle_id
          AND b.target_app_version IN (SELECT unnest(target_app_version_list))
          AND b.channel = target_channel
        ORDER BY b.id DESC
        LIMIT 1
    ),
    rollback_candidate AS (
        SELECT
            b.id,
            TRUE AS should_force_update,
            b.message,
            'ROLLBACK' AS status,
            b.storage_uri,
            b.file_hash
        FROM bundles b
        WHERE b.enabled = TRUE
          AND b.platform = app_platform
          AND b.id < masked_bundle_id_lower
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
    WHERE NOT (final_result.id BETWEEN masked_bundle_id_lower AND masked_bundle_id_upper)

    UNION ALL

    SELECT
        NIL_UUID      AS id,
        TRUE          AS should_force_update,
        NULL          AS message,
        'ROLLBACK'    AS status,
        NULL          AS storage_uri,
        NULL          AS file_hash
    WHERE (SELECT COUNT(*) FROM final_result) = 0
      AND masked_bundle_id_lower != NIL_UUID
      AND masked_bundle_id_lower > min_bundle_id
      AND NOT EXISTS (
          SELECT 1
          FROM bundles b
          WHERE b.id BETWEEN masked_bundle_id_lower AND masked_bundle_id_upper
            AND b.enabled = TRUE
            AND b.platform = app_platform
      );
END;
$$;
