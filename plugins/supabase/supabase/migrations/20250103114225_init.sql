-- HotUpdater.bundles

CREATE TYPE platforms AS ENUM ('ios', 'android');

CREATE TABLE bundles (
    id uuid PRIMARY KEY,
    platform platforms NOT NULL,
    target_app_version text NOT NULL,
    force_update boolean NOT NULL,
    enabled boolean NOT NULL,
    file_url text NOT NULL,
    file_hash text NOT NULL,
    git_commit_hash text,
    message text
);

CREATE INDEX bundles_target_app_version_idx ON bundles(target_app_version);


-- HotUpdater.get_update_info

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

-- HotUpdater.semver_satisfies

CREATE OR REPLACE FUNCTION semver_satisfies(range_expression TEXT, version TEXT)
RETURNS BOOLEAN AS $$
DECLARE
    version_parts TEXT[];
    version_major INT;
    version_minor INT;
    version_patch INT;
    satisfies BOOLEAN := FALSE;
BEGIN
    -- Split the version into major, minor, and patch
    version_parts := string_to_array(version, '.');
    version_major := version_parts[1]::INT;
    version_minor := version_parts[2]::INT;
    version_patch := version_parts[3]::INT;

    -- Parse range expression and evaluate
    IF range_expression ~ '^\d+\.\d+\.\d+$' THEN
        -- Exact match
        satisfies := (range_expression = version);

    ELSIF range_expression = '*' THEN
        -- Matches any version
        satisfies := TRUE;

    ELSIF range_expression ~ '^\d+\.x\.x$' THEN
        -- Matches major.x.x
        DECLARE
            major_range INT := split_part(range_expression, '.', 1)::INT;
        BEGIN
            satisfies := (version_major = major_range);
        END;

    ELSIF range_expression ~ '^\d+\.\d+\.x$' THEN
        -- Matches major.minor.x
        DECLARE
            major_range INT := split_part(range_expression, '.', 1)::INT;
            minor_range INT := split_part(range_expression, '.', 2)::INT;
        BEGIN
            satisfies := (version_major = major_range AND version_minor = minor_range);
        END;

    ELSIF range_expression ~ '^\d+\.\d+$' THEN
        -- Matches major.minor
        DECLARE
            major_range INT := split_part(range_expression, '.', 1)::INT;
            minor_range INT := split_part(range_expression, '.', 2)::INT;
        BEGIN
            satisfies := (version_major = major_range AND version_minor = minor_range);
        END;

    ELSIF range_expression ~ '^\d+\.\d+\.\d+ - \d+\.\d+\.\d+$' THEN
        -- Matches range e.g., 1.2.3 - 1.2.7
        DECLARE
            lower_bound TEXT := split_part(range_expression, ' - ', 1);
            upper_bound TEXT := split_part(range_expression, ' - ', 2);
        BEGIN
            satisfies := (version >= lower_bound AND version <= upper_bound);
        END;

    ELSIF range_expression ~ '^>=\d+\.\d+\.\d+ <\d+\.\d+\.\d+$' THEN
        -- Matches range with inequalities
        DECLARE
            lower_bound TEXT := regexp_replace(range_expression, '>=([\d\.]+) <.*', '\1');
            upper_bound TEXT := regexp_replace(range_expression, '.*<([\d\.]+)', '\1');
        BEGIN
            satisfies := (version >= lower_bound AND version < upper_bound);
        END;

    ELSIF range_expression ~ '^~\d+\.\d+\.\d+$' THEN
        -- Matches ~1.2.3 (>=1.2.3 <1.3.0)
        DECLARE
            lower_bound TEXT := regexp_replace(range_expression, '~', '');
            upper_bound_major INT := split_part(lower_bound, '.', 1)::INT;
            upper_bound_minor INT := split_part(lower_bound, '.', 2)::INT + 1;
            upper_bound TEXT := upper_bound_major || '.' || upper_bound_minor || '.0';
        BEGIN
            satisfies := (version >= lower_bound AND version < upper_bound);
        END;

    ELSIF range_expression ~ '^\^\d+\.\d+\.\d+$' THEN
        -- Matches ^1.2.3 (>=1.2.3 <2.0.0)
        DECLARE
            lower_bound TEXT := regexp_replace(range_expression, '\^', '');
            upper_bound_major INT := split_part(lower_bound, '.', 1)::INT + 1;
            upper_bound TEXT := upper_bound_major || '.0.0';
        BEGIN
            satisfies := (version >= lower_bound AND version < upper_bound);
        END;

    ELSE
        RAISE EXCEPTION 'Unsupported range expression: %', range_expression;
    END IF;

    RETURN satisfies;
END;
$$ LANGUAGE plpgsql;

