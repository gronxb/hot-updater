-- HotUpdater.get_update_info

CREATE OR REPLACE FUNCTION get_update_info_by_fingerprint_hash (
    app_platform   platforms,
    bundle_id  uuid,
    min_bundle_id uuid,
    target_channel text,
    target_fingerprint_hash text,
    device_id TEXT DEFAULT NULL
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
            b.rollout_percentage,
            b.target_device_ids
        FROM bundles b
        WHERE b.enabled = TRUE
          AND b.platform = app_platform
          AND b.id >= min_bundle_id
          AND b.channel = target_channel
          AND b.fingerprint_hash = target_fingerprint_hash
    ),
    current_candidate AS (
        SELECT cb.id
        FROM candidate_bundles cb
        WHERE cb.id = bundle_id
        LIMIT 1
    ),
    any_update_candidate AS (
        SELECT cb.id
        FROM candidate_bundles cb
        WHERE cb.id > bundle_id
        ORDER BY cb.id DESC
        LIMIT 1
    ),
    update_candidate AS (
        SELECT
            cb.id,
            cb.should_force_update,
            cb.message,
            'UPDATE' AS status,
            cb.storage_uri,
            cb.file_hash
        FROM candidate_bundles cb
        WHERE cb.id > bundle_id
          AND (
            device_id IS NULL
            OR is_device_eligible(
              device_id,
              cb.rollout_percentage,
              cb.target_device_ids
            )
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
          AND NOT EXISTS (SELECT 1 FROM current_candidate)
          AND NOT EXISTS (SELECT 1 FROM any_update_candidate)
        ORDER BY cb.id DESC
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
      AND NOT EXISTS (SELECT 1 FROM current_candidate)
      AND NOT EXISTS (SELECT 1 FROM any_update_candidate)
      AND NOT EXISTS (SELECT 1 FROM rollback_candidate);
END;
$$;
