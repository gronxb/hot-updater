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

    -- [Added] 1) Single major version pattern '^(\d+)$'
    ELSIF range_expression ~ '^\d+$' THEN
        /*
            e.g.) "1" is interpreted as (>=1.0.0 <2.0.0) in semver range
                  "2" would be interpreted as (>=2.0.0 <3.0.0)
         */
        DECLARE
            major_range INT := range_expression::INT;
            lower_bound TEXT := major_range || '.0.0';
            upper_bound TEXT := (major_range + 1) || '.0.0';
        BEGIN
            satisfies := (version >= lower_bound AND version < upper_bound);
        END;

    -- [Added] 2) major.x pattern '^(\d+)\.x$'
    ELSIF range_expression ~ '^\d+\.x$' THEN
        /*
            e.g.) "2.x" => as long as major=2 matches, any minor and patch is OK
                  effectively works like (>=2.0.0 <3.0.0)
         */
        DECLARE
            major_range INT := split_part(range_expression, '.', 1)::INT;
            lower_bound TEXT := major_range || '.0.0';
            upper_bound TEXT := (major_range + 1) || '.0.0';
        BEGIN
            satisfies := (version >= lower_bound AND version < upper_bound);
        END;

    ELSE
        RAISE EXCEPTION 'Unsupported range expression: %', range_expression;
    END IF;

    RETURN satisfies;
END;
$$ LANGUAGE plpgsql;