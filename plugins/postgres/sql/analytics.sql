-- noqa: SIZE_OK - This published migration must remain one transaction so
-- validation, data-preserving upgrades, and the final marker roll back together.
-- HotUpdater.analytics

BEGIN;

CREATE TABLE IF NOT EXISTS public.private_hot_updater_settings (
  key text PRIMARY KEY NOT NULL,
  value text NOT NULL
);

DO $$
DECLARE
  component_version text;
  legacy_version text;
  shape text;
  column_signature text;
  index_signature text;
  constraint_signature text;
  settings_valid boolean;
  write_marker boolean := false;
  v1_columns constant text :=
    'id:uuid:NO,type:text:NO,install_id:text:NO,user_id:text:YES,' ||
    'username:text:YES,from_bundle_id:uuid:NO,to_bundle_id:uuid:NO,' ||
    'platform:text:NO,app_version:text:NO,channel:text:NO,cohort:text:NO,' ||
    'update_strategy:text:NO,fingerprint_hash:text:YES,sdk_version:text:YES,' ||
    'received_at_ms:double precision:NO';
  v2_columns_double constant text :=
    'id:uuid:NO,type:text:NO,install_id:text:NO,user_id:text:YES,' ||
    'username:text:YES,from_bundle_id:uuid:YES,to_bundle_id:uuid:NO,' ||
    'platform:text:NO,app_version:text:NO,channel:text:NO,cohort:text:NO,' ||
    'update_strategy:text:YES,fingerprint_hash:text:YES,sdk_version:text:YES,' ||
    'received_at_ms:double precision:NO';
  expected_indexes constant text :=
    'bundle_events_cohort_idx:false:cohort,type,received_at_ms,id|' ||
    'bundle_events_install_idx:false:install_id,received_at_ms,id|' ||
    'bundle_events_installed_bundle_idx:false:type,to_bundle_id,received_at_ms,id|' ||
    'bundle_events_pkey:true:id|' ||
    'bundle_events_received_at_idx:false:received_at_ms,id|' ||
    'bundle_events_recovered_bundle_idx:false:type,from_bundle_id,received_at_ms,id|' ||
    'bundle_events_user_id_idx:false:user_id,received_at_ms,id|' ||
    'bundle_events_username_idx:false:username,received_at_ms,id';
  v1_constraints text;
  v2_constraints text;
BEGIN
  SELECT
    count(*) = 2
    AND count(*) FILTER (
      WHERE column_name = 'key'
        AND data_type IN ('text', 'character varying')
        AND is_nullable = 'NO'
    ) = 1
    AND count(*) FILTER (
      WHERE column_name = 'value'
        AND data_type = 'text'
        AND is_nullable = 'NO'
    ) = 1
  INTO settings_valid
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'private_hot_updater_settings';

  IF NOT settings_valid OR NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.private_hot_updater_settings'::regclass
      AND contype = 'p'
      AND pg_get_constraintdef(oid) = 'PRIMARY KEY (key)'
  ) THEN
    RAISE EXCEPTION 'Hot Updater settings schema is incompatible with Analytics';
  END IF;

  SELECT value INTO component_version
  FROM public.private_hot_updater_settings
  WHERE key = 'schema.analytics';

  SELECT value INTO legacy_version
  FROM public.private_hot_updater_settings
  WHERE key = 'version';

  IF legacy_version IS NOT NULL AND legacy_version NOT IN (
    '0.21.0', '0.29.0', '0.31.0', '0.36.0', '0.37.0', '0.38.0'
  ) THEN
    RAISE EXCEPTION 'Unknown legacy Hot Updater schema version: %', legacy_version;
  END IF;

  IF component_version IS NOT NULL AND component_version NOT IN ('1', '2') THEN
    RAISE EXCEPTION 'Unknown Analytics schema version: %', component_version;
  END IF;

  CREATE TEMP TABLE hot_updater_analytics_v1_reference (
    id uuid PRIMARY KEY NOT NULL,
    type text NOT NULL,
    install_id text NOT NULL,
    user_id text,
    username text,
    from_bundle_id uuid NOT NULL,
    to_bundle_id uuid NOT NULL,
    platform text NOT NULL,
    app_version text NOT NULL,
    channel text NOT NULL,
    cohort text NOT NULL,
    update_strategy text NOT NULL,
    fingerprint_hash text,
    sdk_version text,
    received_at_ms double precision NOT NULL,
    CONSTRAINT reference_v1_type
      CHECK (type IN ('UPDATE_APPLIED', 'RECOVERED')),
    CONSTRAINT reference_v1_strategy
      CHECK (update_strategy IN ('fingerprint', 'appVersion'))
  ) ON COMMIT DROP;

  CREATE TEMP TABLE hot_updater_analytics_v2_reference (
    id uuid PRIMARY KEY NOT NULL,
    type text NOT NULL,
    install_id text NOT NULL,
    user_id text,
    username text,
    from_bundle_id uuid,
    to_bundle_id uuid NOT NULL,
    platform text NOT NULL,
    app_version text NOT NULL,
    channel text NOT NULL,
    cohort text NOT NULL,
    update_strategy text,
    fingerprint_hash text,
    sdk_version text,
    received_at_ms double precision NOT NULL,
    CONSTRAINT reference_v2_type
      CHECK (type IN ('UPDATE_APPLIED', 'RECOVERED', 'UNCHANGED')),
    CONSTRAINT reference_v2_strategy
      CHECK (update_strategy IS NULL OR
        update_strategy IN ('fingerprint', 'appVersion')),
    CONSTRAINT reference_v2_shape CHECK (
      (type IN ('UPDATE_APPLIED', 'RECOVERED')
        AND from_bundle_id IS NOT NULL
        AND update_strategy IS NOT NULL)
      OR (type = 'UNCHANGED'
        AND from_bundle_id IS NULL
        AND update_strategy IS NULL)
    )
  ) ON COMMIT DROP;

  SELECT string_agg(
    expected_name || ':' || pg_get_constraintdef(oid) ||
      CASE WHEN convalidated THEN '' ELSE ':invalid' END,
    '|' ORDER BY expected_name
  )
  INTO v1_constraints
  FROM (
    SELECT oid, convalidated, CASE conname
      WHEN 'hot_updater_analytics_v1_reference_pkey' THEN 'bundle_events_pkey'
      WHEN 'reference_v1_type' THEN 'bundle_events_type_check'
      WHEN 'reference_v1_strategy' THEN 'bundle_events_update_strategy_check'
    END AS expected_name
    FROM pg_constraint
    WHERE conrelid = 'pg_temp.hot_updater_analytics_v1_reference'::regclass
  ) AS reference_constraints;

  SELECT string_agg(
    expected_name || ':' || pg_get_constraintdef(oid) ||
      CASE WHEN convalidated THEN '' ELSE ':invalid' END,
    '|' ORDER BY expected_name
  )
  INTO v2_constraints
  FROM (
    SELECT oid, convalidated, CASE conname
      WHEN 'hot_updater_analytics_v2_reference_pkey' THEN 'bundle_events_pkey'
      WHEN 'reference_v2_type' THEN 'bundle_events_type_v038_check'
      WHEN 'reference_v2_strategy' THEN 'bundle_events_update_strategy_v038_check'
      WHEN 'reference_v2_shape' THEN 'bundle_events_shape_v038_check'
    END AS expected_name
    FROM pg_constraint
    WHERE conrelid = 'pg_temp.hot_updater_analytics_v2_reference'::regclass
  ) AS reference_constraints;

  IF to_regclass('public.bundle_events') IS NULL THEN
    shape := 'absent';
  ELSE
    SELECT string_agg(
      column_name || ':' || data_type || ':' || is_nullable,
      ',' ORDER BY ordinal_position
    )
    INTO column_signature
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'bundle_events';

    SELECT string_agg(
      index_class.relname || ':' || index.indisunique::text || ':' ||
      coalesce((
        SELECT string_agg(attribute.attname, ',' ORDER BY key.ordinality)
        FROM unnest(index.indkey::smallint[]) WITH ORDINALITY
          AS key(attnum, ordinality)
        JOIN pg_attribute AS attribute
          ON attribute.attrelid = index.indrelid
          AND attribute.attnum = key.attnum
      ), '') || CASE WHEN
        index.indpred IS NULL
        AND index.indexprs IS NULL
        AND index.indisvalid
        AND index.indisready
        AND index.indnkeyatts = index.indnatts
        AND NOT EXISTS (
          SELECT 1 FROM unnest(index.indoption::smallint[]) AS option
          WHERE option <> 0
        )
      THEN '' ELSE ':invalid' END,
      '|' ORDER BY index_class.relname
    )
    INTO index_signature
    FROM pg_index AS index
    JOIN pg_class AS index_class ON index_class.oid = index.indexrelid
    WHERE index.indrelid = 'public.bundle_events'::regclass;

    SELECT string_agg(
      conname || ':' || pg_get_constraintdef(oid) ||
        CASE WHEN convalidated THEN '' ELSE ':invalid' END,
      '|' ORDER BY conname
    )
    INTO constraint_signature
    FROM pg_constraint
    WHERE conrelid = 'public.bundle_events'::regclass;

    IF column_signature = v1_columns
      AND index_signature = expected_indexes
      AND constraint_signature = v1_constraints THEN
      shape := 'v1';
    ELSIF column_signature = v2_columns_double
      AND index_signature = expected_indexes
      AND constraint_signature = v2_constraints THEN
      shape := 'v2';
    ELSE
      shape := 'drift';
    END IF;
  END IF;

  IF component_version = '2' THEN
    IF shape <> 'v2' THEN
      RAISE EXCEPTION 'Analytics marker 2 contradicts physical shape %', shape;
    END IF;
  ELSIF component_version = '1' THEN
    IF shape = 'v1' THEN
      ALTER TABLE public.bundle_events
        DROP CONSTRAINT bundle_events_type_check,
        DROP CONSTRAINT bundle_events_update_strategy_check,
        ALTER COLUMN from_bundle_id DROP NOT NULL,
        ALTER COLUMN update_strategy DROP NOT NULL,
        ADD CONSTRAINT bundle_events_type_v038_check
          CHECK (type IN ('UPDATE_APPLIED', 'RECOVERED', 'UNCHANGED')),
        ADD CONSTRAINT bundle_events_update_strategy_v038_check
          CHECK (update_strategy IS NULL OR
            update_strategy IN ('fingerprint', 'appVersion')),
        ADD CONSTRAINT bundle_events_shape_v038_check CHECK (
          (type IN ('UPDATE_APPLIED', 'RECOVERED')
            AND from_bundle_id IS NOT NULL
            AND update_strategy IS NOT NULL)
          OR (type = 'UNCHANGED'
            AND from_bundle_id IS NULL
            AND update_strategy IS NULL)
        );
    ELSIF shape <> 'v2' THEN
      RAISE EXCEPTION 'Analytics marker 1 contradicts physical shape %', shape;
    END IF;
    write_marker := true;
  ELSIF shape = 'absent' THEN
    IF legacy_version IN ('0.37.0', '0.38.0') THEN
      RAISE EXCEPTION 'Legacy schema % requires an Analytics table', legacy_version;
    END IF;
    CREATE TABLE public.bundle_events (
      id uuid PRIMARY KEY NOT NULL,
      type text NOT NULL,
      install_id text NOT NULL,
      user_id text,
      username text,
      from_bundle_id uuid,
      to_bundle_id uuid NOT NULL,
      platform text NOT NULL,
      app_version text NOT NULL,
      channel text NOT NULL,
      cohort text NOT NULL,
      update_strategy text,
      fingerprint_hash text,
      sdk_version text,
      received_at_ms double precision NOT NULL,
      CONSTRAINT bundle_events_type_v038_check
        CHECK (type IN ('UPDATE_APPLIED', 'RECOVERED', 'UNCHANGED')),
      CONSTRAINT bundle_events_update_strategy_v038_check
        CHECK (update_strategy IS NULL OR
          update_strategy IN ('fingerprint', 'appVersion')),
      CONSTRAINT bundle_events_shape_v038_check CHECK (
        (type IN ('UPDATE_APPLIED', 'RECOVERED')
          AND from_bundle_id IS NOT NULL
          AND update_strategy IS NOT NULL)
        OR (type = 'UNCHANGED'
          AND from_bundle_id IS NULL
          AND update_strategy IS NULL)
      )
    );
    CREATE INDEX bundle_events_installed_bundle_idx
      ON public.bundle_events(type, to_bundle_id, received_at_ms, id);
    CREATE INDEX bundle_events_recovered_bundle_idx
      ON public.bundle_events(type, from_bundle_id, received_at_ms, id);
    CREATE INDEX bundle_events_install_idx
      ON public.bundle_events(install_id, received_at_ms, id);
    CREATE INDEX bundle_events_user_id_idx
      ON public.bundle_events(user_id, received_at_ms, id);
    CREATE INDEX bundle_events_username_idx
      ON public.bundle_events(username, received_at_ms, id);
    CREATE INDEX bundle_events_cohort_idx
      ON public.bundle_events(cohort, type, received_at_ms, id);
    CREATE INDEX bundle_events_received_at_idx
      ON public.bundle_events(received_at_ms, id);
    write_marker := true;
  ELSIF shape = 'v1' THEN
    IF legacy_version <> '0.37.0' THEN
      RAISE EXCEPTION 'Schema 1 contradicts legacy schema %', legacy_version;
    END IF;
    ALTER TABLE public.bundle_events
      DROP CONSTRAINT bundle_events_type_check,
      DROP CONSTRAINT bundle_events_update_strategy_check,
      ALTER COLUMN from_bundle_id DROP NOT NULL,
      ALTER COLUMN update_strategy DROP NOT NULL,
      ADD CONSTRAINT bundle_events_type_v038_check
        CHECK (type IN ('UPDATE_APPLIED', 'RECOVERED', 'UNCHANGED')),
      ADD CONSTRAINT bundle_events_update_strategy_v038_check
        CHECK (update_strategy IS NULL OR
          update_strategy IN ('fingerprint', 'appVersion')),
      ADD CONSTRAINT bundle_events_shape_v038_check CHECK (
        (type IN ('UPDATE_APPLIED', 'RECOVERED')
          AND from_bundle_id IS NOT NULL
          AND update_strategy IS NOT NULL)
        OR (type = 'UNCHANGED'
          AND from_bundle_id IS NULL
          AND update_strategy IS NULL)
      );
    write_marker := true;
  ELSIF shape = 'v2' THEN
    write_marker := true;
  ELSE
    RAISE EXCEPTION 'Analytics schema has unsupported physical drift';
  END IF;

  SELECT string_agg(
    column_name || ':' || data_type || ':' || is_nullable,
    ',' ORDER BY ordinal_position
  )
  INTO column_signature
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'bundle_events';

  SELECT string_agg(
    index_class.relname || ':' || index.indisunique::text || ':' ||
    coalesce((
      SELECT string_agg(attribute.attname, ',' ORDER BY key.ordinality)
      FROM unnest(index.indkey::smallint[]) WITH ORDINALITY
        AS key(attnum, ordinality)
      JOIN pg_attribute AS attribute
        ON attribute.attrelid = index.indrelid
        AND attribute.attnum = key.attnum
    ), '') || CASE WHEN
      index.indpred IS NULL
      AND index.indexprs IS NULL
      AND index.indisvalid
      AND index.indisready
      AND index.indnkeyatts = index.indnatts
      AND NOT EXISTS (
        SELECT 1 FROM unnest(index.indoption::smallint[]) AS option
        WHERE option <> 0
      )
    THEN '' ELSE ':invalid' END,
    '|' ORDER BY index_class.relname
  )
  INTO index_signature
  FROM pg_index AS index
  JOIN pg_class AS index_class ON index_class.oid = index.indexrelid
  WHERE index.indrelid = 'public.bundle_events'::regclass;

  SELECT string_agg(
    conname || ':' || pg_get_constraintdef(oid) ||
      CASE WHEN convalidated THEN '' ELSE ':invalid' END,
    '|' ORDER BY conname
  )
  INTO constraint_signature
  FROM pg_constraint
  WHERE conrelid = 'public.bundle_events'::regclass;

  IF column_signature <> v2_columns_double
    OR index_signature <> expected_indexes
    OR constraint_signature <> v2_constraints THEN
    RAISE EXCEPTION 'Analytics schema 2 validation failed';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.bundle_events
    WHERE type NOT IN ('UPDATE_APPLIED', 'RECOVERED', 'UNCHANGED')
      OR platform NOT IN ('ios', 'android')
      OR install_id = ''
      OR app_version = ''
      OR channel = ''
      OR cohort = ''
      OR user_id = ''
      OR username = ''
      OR fingerprint_hash = ''
      OR sdk_version = ''
      OR update_strategy NOT IN ('fingerprint', 'appVersion')
      OR (type IN ('UPDATE_APPLIED', 'RECOVERED') AND (
        from_bundle_id IS NULL OR update_strategy IS NULL
      ))
      OR (type = 'UNCHANGED' AND (
        from_bundle_id IS NOT NULL OR update_strategy IS NOT NULL
      ))
      OR received_at_ms < 0
      OR received_at_ms > 9007199254740991
      OR received_at_ms <> trunc(received_at_ms)
  ) THEN
    RAISE EXCEPTION 'Analytics schema contains invalid bundle event rows';
  END IF;

  DROP TABLE pg_temp.hot_updater_analytics_v1_reference;
  DROP TABLE pg_temp.hot_updater_analytics_v2_reference;

  IF write_marker THEN
    INSERT INTO public.private_hot_updater_settings (key, value)
    VALUES ('schema.analytics', '2')
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
  END IF;
END;
$$;

COMMIT;
