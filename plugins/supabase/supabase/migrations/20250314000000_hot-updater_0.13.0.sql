-- HotUpdater.semver_satisfies
DROP FUNCTION IF EXISTS semver_satisfies;

-- HotUpdater.get_update_info
DROP FUNCTION IF EXISTS get_update_info;

-- HotUpdater.get_update_info
CREATE OR REPLACE FUNCTION get_update_info (
    app_platform   platforms,
    app_version text,
    bundle_id  uuid,
    min_bundle_id uuid,
    target_channel text,
    target_app_version_list text[]
)
RETURNS TABLE (
    id            uuid,
    should_force_update  boolean,
    message       text,
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
            b.message,
            'UPDATE' AS status
        FROM bundles b
        WHERE b.enabled = TRUE
          AND b.platform = app_platform
          AND b.id >= bundle_id
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

    SELECT
        NIL_UUID      AS id,
        TRUE          AS should_force_update,
        NULL          AS message,
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

-- HotUpdater.bundles
ALTER TABLE bundles
ADD COLUMN channel text NOT NULL DEFAULT 'production';

ALTER TABLE bundles
DROP COLUMN file_url;

-- HotUpdater.get_target_app_version_list

CREATE OR REPLACE FUNCTION get_target_app_version_list (
    app_platform platforms,
    min_bundle_id uuid
)
RETURNS TABLE (
    target_app_version text
)
LANGUAGE plpgsql
AS
$$
BEGIN
    RETURN QUERY
    SELECT b.target_app_version
    FROM bundles b 
    WHERE b.platform = app_platform
    AND b.id >= min_bundle_id
    GROUP BY b.target_app_version;
END;
$$;

-- HotUpdater.get_channels
CREATE OR REPLACE FUNCTION get_channels ()
RETURNS TABLE (
    channel text
)
LANGUAGE plpgsql
AS
$$
BEGIN
    RETURN QUERY
    SELECT b.channel
    FROM bundles b 
    GROUP BY b.channel;
END;
$$;

CREATE INDEX bundles_channel_idx ON bundles(channel);
