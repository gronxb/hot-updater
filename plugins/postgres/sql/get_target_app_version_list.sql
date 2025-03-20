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
