-- HotUpdater.insightsScale

CREATE FUNCTION public.hot_updater_v1_insights_canonical_json(p_value jsonb)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path = pg_catalog
AS $$
DECLARE
  v_type text := jsonb_typeof(p_value);
  v_result text;
BEGIN
  IF v_type = 'object' THEN
    SELECT '{' || coalesce(string_agg(
      to_jsonb(entry.key)::text || ':' ||
        public.hot_updater_v1_insights_canonical_json(entry.value),
      ',' ORDER BY entry.key COLLATE "C"
    ), '') || '}'
    INTO v_result
    FROM jsonb_each(p_value) AS entry;
    RETURN v_result;
  ELSIF v_type = 'array' THEN
    SELECT '[' || coalesce(string_agg(
      public.hot_updater_v1_insights_canonical_json(item.value),
      ',' ORDER BY item.ordinality
    ), '') || ']'
    INTO v_result
    FROM jsonb_array_elements(p_value) WITH ORDINALITY AS item(value, ordinality);
    RETURN v_result;
  END IF;
  RETURN p_value::text;
END;
$$;

REVOKE ALL ON FUNCTION public.hot_updater_v1_insights_canonical_json(jsonb)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.hot_updater_v1_insights_js_order(p_value text)
RETURNS bytea
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path = pg_catalog
AS $$
DECLARE
  v_hex text := '';
  v_codepoint integer;
  v_position integer;
BEGIN
  IF char_length(p_value) = 0 THEN RETURN ''::bytea; END IF;
  FOR v_position IN 1..char_length(p_value) LOOP
    v_codepoint := ascii(substr(p_value, v_position, 1));
    IF v_codepoint <= 65535 THEN
      v_hex := v_hex || lpad(to_hex(v_codepoint), 4, '0');
    ELSE
      v_codepoint := v_codepoint - 65536;
      v_hex := v_hex || lpad(to_hex(55296 + (v_codepoint >> 10)), 4, '0') ||
        lpad(to_hex(56320 + (v_codepoint & 1023)), 4, '0');
    END IF;
  END LOOP;
  RETURN decode(v_hex, 'hex');
END;
$$;

REVOKE ALL ON FUNCTION public.hot_updater_v1_insights_js_order(text)
  FROM PUBLIC, anon, authenticated, service_role;

ALTER TABLE public.hot_updater_v1_bundle_events
  ADD COLUMN insights_event jsonb,
  ADD COLUMN insights_event_bytes integer,
  ADD COLUMN insights_source_seq bigint,
  ADD COLUMN insights_install_key bytea,
  ADD COLUMN insights_cohort_order bytea;
ALTER TABLE public.hot_updater_v1_bundle_events
  ADD CONSTRAINT hot_updater_v1_bundle_events_event_bytes_check
    CHECK (insights_event_bytes IS NULL OR insights_event_bytes BETWEEN 0 AND 20480),
  ADD CONSTRAINT hot_updater_v1_bundle_events_install_key_check
    CHECK (insights_install_key IS NULL OR octet_length(insights_install_key) = 32),
  ADD CONSTRAINT hot_updater_v1_bundle_events_cohort_order_check
    CHECK (insights_cohort_order IS NULL OR
      octet_length(insights_cohort_order) <= 2048);

DROP INDEX IF EXISTS public.hot_updater_v1_bundle_events_install_idx;
DROP INDEX IF EXISTS public.hot_updater_v1_bundle_events_user_id_idx;
DROP INDEX IF EXISTS public.hot_updater_v1_bundle_events_username_idx;

-- Databases that already applied the v1 migration may still have the former
-- generic SECURITY DEFINER writer. Fence every unsequenced insert at the
-- table boundary so that writer cannot bypass the native append RPC.
CREATE FUNCTION public.hot_updater_v1_insights_fence_unsequenced_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.insights_source_seq IS NULL THEN
    RAISE EXCEPTION 'Insights events require the append RPC'
      USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION
  public.hot_updater_v1_insights_fence_unsequenced_insert()
  FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER hot_updater_v1_insights_fence_unsequenced_insert
BEFORE INSERT ON public.hot_updater_v1_bundle_events
FOR EACH ROW
EXECUTE FUNCTION public.hot_updater_v1_insights_fence_unsequenced_insert();

-- Databases that already ran the original v1 migration retain its generic
-- Insights branch inside hot_updater_v1_commit. Keep the other commit models
-- behind the same RPC name, but make that obsolete branch unreachable even if
-- an administrator later disables the table trigger.
ALTER FUNCTION public.hot_updater_v1_commit(jsonb)
  RENAME TO hot_updater_v1_commit_before_insights_v2;
REVOKE ALL ON FUNCTION public.hot_updater_v1_commit_before_insights_v2(jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
CREATE FUNCTION public.hot_updater_v1_commit(p_commit jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF jsonb_typeof(p_commit)='object'
    AND jsonb_typeof(p_commit->'changes')='array'
    AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_commit->'changes') AS change(value)
      WHERE change.value->>'model'='insights'
    )
  THEN
    RAISE EXCEPTION 'Insights events require the append RPC'
      USING ERRCODE='22023';
  END IF;
  RETURN public.hot_updater_v1_commit_before_insights_v2(p_commit);
END;
$$;
REVOKE ALL ON FUNCTION public.hot_updater_v1_commit(jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hot_updater_v1_commit(jsonb) TO service_role;

CREATE FUNCTION public.hot_updater_v1_insights_event_json(
  p_event public.hot_updater_v1_bundle_events
) RETURNS jsonb
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog
AS $$
  SELECT coalesce(
    p_event.insights_event,
    to_jsonb(p_event) - 'insights_event' - 'insights_event_bytes' -
      'insights_source_seq' -
      'insights_install_key' - 'insights_cohort_order'
  )
$$;
REVOKE ALL ON FUNCTION public.hot_updater_v1_insights_event_json(
  public.hot_updater_v1_bundle_events
) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.hot_updater_v1_insights_event_matches_row(
  p_event public.hot_updater_v1_bundle_events
) RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog, public
AS $$
  SELECT p_event.id::text ~
      '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND p_event.received_at_ms = trunc(p_event.received_at_ms)
    AND p_event.received_at_ms >= 0
    AND p_event.received_at_ms <= 9007199254740991
    AND octet_length(public.hot_updater_v1_insights_js_order(
      p_event.install_id)) <= 2048
    AND (p_event.user_id IS NULL OR octet_length(
      public.hot_updater_v1_insights_js_order(p_event.user_id)) <= 2048)
    AND (p_event.username IS NULL OR octet_length(
      public.hot_updater_v1_insights_js_order(p_event.username)) <= 2048)
    AND octet_length(public.hot_updater_v1_insights_js_order(
      p_event.app_version)) <= 2048
    AND octet_length(public.hot_updater_v1_insights_js_order(
      p_event.channel)) <= 2048
    AND octet_length(public.hot_updater_v1_insights_js_order(
      p_event.cohort)) <= 2048
    AND (p_event.fingerprint_hash IS NULL OR octet_length(
      public.hot_updater_v1_insights_js_order(p_event.fingerprint_hash)) <= 2048)
    AND (p_event.sdk_version IS NULL OR octet_length(
      public.hot_updater_v1_insights_js_order(p_event.sdk_version)) <= 2048)
    AND jsonb_typeof(public.hot_updater_v1_insights_event_json(p_event)) =
      'object'
    AND public.hot_updater_v1_insights_event_json(p_event) @>
      jsonb_build_object(
        'id',p_event.id,'type',p_event.type,'install_id',p_event.install_id,
        'user_id',p_event.user_id,'username',p_event.username,
        'from_release_id',p_event.from_release_id,
        'from_bundle_id',p_event.from_bundle_id,
        'to_release_id',p_event.to_release_id,
        'to_bundle_id',p_event.to_bundle_id,'platform',p_event.platform,
        'app_version',p_event.app_version,'channel',p_event.channel,
        'cohort',p_event.cohort,'update_strategy',p_event.update_strategy,
        'fingerprint_hash',p_event.fingerprint_hash,
        'sdk_version',p_event.sdk_version,
        'received_at_ms',p_event.received_at_ms
      )
    AND p_event.insights_event_bytes BETWEEN 0 AND 20480
$$;
REVOKE ALL ON FUNCTION public.hot_updater_v1_insights_event_matches_row(
  public.hot_updater_v1_bundle_events
) FROM PUBLIC, anon, authenticated, service_role;

CREATE UNIQUE INDEX hot_updater_v1_bundle_events_source_seq_key
  ON public.hot_updater_v1_bundle_events(insights_source_seq)
  WHERE insights_source_seq IS NOT NULL;
CREATE INDEX hot_updater_v1_bundle_events_migration_idx
  ON public.hot_updater_v1_bundle_events(id)
  WHERE insights_source_seq IS NULL;

CREATE INDEX hot_updater_v1_bundle_events_install_source_idx
  ON public.hot_updater_v1_bundle_events(
    insights_install_key, insights_source_seq DESC
  );
CREATE INDEX hot_updater_v1_bundle_events_install_type_idx
  ON public.hot_updater_v1_bundle_events(
    insights_install_key, type, received_at_ms, id
  );

CREATE TABLE public.hot_updater_v1_insights_source_state (
  id integer PRIMARY KEY CHECK (id = 1),
  version integer NOT NULL CHECK (version = 2),
  database_namespace uuid,
  source_id uuid NOT NULL,
  committed_seq bigint NOT NULL CHECK (committed_seq >= 0),
  ready boolean NOT NULL,
  migration_after_id uuid,
  poison text,
  layout jsonb NOT NULL DEFAULT '{}'::jsonb
);

INSERT INTO public.hot_updater_v1_insights_source_state
  (id, version, source_id, committed_seq, ready, migration_after_id, poison)
SELECT 1, 2, gen_random_uuid(), 0,
  NOT EXISTS (SELECT 1 FROM public.hot_updater_v1_bundle_events LIMIT 1),
  null, null;

CREATE FUNCTION public.hot_updater_v1_insights_bind_namespace(
  p_database_namespace uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_database_namespace IS NULL THEN
    RAISE EXCEPTION 'Invalid Insights database namespace'
      USING ERRCODE='22023';
  END IF;
  UPDATE public.hot_updater_v1_insights_source_state AS source
  SET database_namespace=p_database_namespace
  WHERE source.id=1 AND source.version=2
    AND source.database_namespace IS NULL;
  IF NOT EXISTS (
    SELECT 1 FROM public.hot_updater_v1_insights_source_state AS source
    WHERE source.id=1 AND source.version=2
      AND source.database_namespace=p_database_namespace
  ) THEN
    RAISE EXCEPTION 'INSIGHTS_DATABASE_NAMESPACE_MISMATCH'
      USING ERRCODE='P0001';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.hot_updater_v1_insights_bind_namespace(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.hot_updater_v1_insights_require_namespace(
  p_database_namespace uuid
) RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_database_namespace IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.hot_updater_v1_insights_source_state AS source
    WHERE source.id=1 AND source.version=2
      AND source.database_namespace=p_database_namespace
  ) THEN
    RAISE EXCEPTION 'INSIGHTS_DATABASE_NAMESPACE_MISMATCH'
      USING ERRCODE='P0001';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.hot_updater_v1_insights_require_namespace(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE public.hot_updater_v1_insights_live_installations (
  install_key bytea PRIMARY KEY CHECK (octet_length(install_key) = 32),
  install_id text NOT NULL,
  event_id uuid NOT NULL,
  received_at_ms double precision NOT NULL,
  source_seq bigint NOT NULL,
  event jsonb NOT NULL
);

CREATE TABLE public.hot_updater_v1_insights_installation_versions (
  install_key bytea NOT NULL CHECK (octet_length(install_key) = 32),
  source_seq bigint NOT NULL CHECK (source_seq > 0),
  event_id uuid NOT NULL REFERENCES public.hot_updater_v1_bundle_events(id),
  PRIMARY KEY (install_key, source_seq)
);

CREATE TABLE public.hot_updater_v1_insights_aliases (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_seq bigint NOT NULL,
  install_key bytea NOT NULL CHECK (octet_length(install_key) = 32),
  install_id text NOT NULL,
  alias_kind text NOT NULL CHECK (
    alias_kind IN ('installationId', 'userId', 'username')
  ),
  alias_key bytea NOT NULL CHECK (octet_length(alias_key) = 32),
  original_alias text NOT NULL,
  normalized_alias text NOT NULL,
  CONSTRAINT hot_updater_v1_insights_aliases_identity_key
    UNIQUE (alias_kind, alias_key, install_key)
);

CREATE INDEX hot_updater_v1_insights_aliases_scan_idx
  ON public.hot_updater_v1_insights_aliases(id, source_seq);
CREATE INDEX hot_updater_v1_insights_aliases_exact_idx
  ON public.hot_updater_v1_insights_aliases(
    alias_kind, alias_key, id, source_seq, install_key
  );

CREATE FUNCTION public.hot_updater_v1_insights_insert_alias(
  p_source_seq bigint, p_install_key bytea, p_install_id text,
  p_alias_kind text, p_original_alias text, p_normalized_alias text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_alias_key bytea:=sha256(convert_to(
    to_jsonb(p_original_alias)::text,'utf8'
  ));
  v_existing public.hot_updater_v1_insights_aliases;
BEGIN
  INSERT INTO public.hot_updater_v1_insights_aliases (
    source_seq, install_key, install_id, alias_kind, alias_key, original_alias,
    normalized_alias
  ) VALUES (
    p_source_seq, p_install_key, p_install_id, p_alias_kind, v_alias_key,
    p_original_alias, p_normalized_alias
  ) ON CONFLICT DO NOTHING;
  IF FOUND THEN RETURN true; END IF;

  SELECT alias.* INTO v_existing
  FROM public.hot_updater_v1_insights_aliases AS alias
  WHERE alias.alias_kind=p_alias_kind AND alias.alias_key=v_alias_key
    AND alias.install_key=p_install_key;
  IF NOT FOUND OR v_existing.install_id<>p_install_id
    OR v_existing.original_alias<>p_original_alias
    OR v_existing.normalized_alias<>p_normalized_alias
  THEN
    RAISE EXCEPTION 'INSIGHTS_STORAGE_CORRUPTION' USING ERRCODE='P0001';
  END IF;
  RETURN false;
END;
$$;
REVOKE ALL ON FUNCTION public.hot_updater_v1_insights_insert_alias(
  bigint, bytea, text, text, text, text
) FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE public.hot_updater_v1_insights_search_jobs (
  id text PRIMARY KEY,
  query_key bytea NOT NULL,
  selector jsonb NOT NULL,
  source_id uuid NOT NULL,
  source_seq bigint NOT NULL,
  source_generation text NOT NULL,
  as_of_ms double precision NOT NULL,
  alias_upper_id bigint NOT NULL CHECK (alias_upper_id >= 0),
  after_alias_id bigint NOT NULL DEFAULT 0,
  phase text NOT NULL DEFAULT 'aliases' CHECK (phase IN ('aliases', 'results')),
  result_after_key bytea CHECK (
    result_after_key IS NULL OR octet_length(result_after_key) = 32
  ),
  lease_epoch bigint NOT NULL DEFAULT 0 CHECK (lease_epoch >= 0),
  lease_owner uuid,
  lease_expires_at_ms double precision,
  state text NOT NULL CHECK (state IN ('preparing', 'ready', 'failed')),
  completed_at_ms double precision,
  total bigint NOT NULL DEFAULT 0 CHECK (total >= 0),
  error text,
  visible boolean NOT NULL DEFAULT true
);
CREATE INDEX hot_updater_v1_insights_search_jobs_lookup_idx
  ON public.hot_updater_v1_insights_search_jobs(
    query_key, as_of_ms DESC, id COLLATE "C" DESC
  );
CREATE INDEX hot_updater_v1_insights_search_jobs_state_lookup_idx
  ON public.hot_updater_v1_insights_search_jobs(
    query_key, state, as_of_ms DESC, id COLLATE "C" DESC
  );
CREATE UNIQUE INDEX hot_updater_v1_insights_search_jobs_active_idx
  ON public.hot_updater_v1_insights_search_jobs(query_key)
  WHERE state = 'preparing';
CREATE INDEX hot_updater_v1_insights_search_jobs_retention_idx
  ON public.hot_updater_v1_insights_search_jobs(
    state, completed_at_ms, id COLLATE "C"
  );
CREATE INDEX hot_updater_v1_insights_search_jobs_queue_idx
  ON public.hot_updater_v1_insights_search_jobs(id COLLATE "C")
  WHERE state='preparing' AND visible;

CREATE TABLE public.hot_updater_v1_insights_search_members (
  job_id text NOT NULL REFERENCES public.hot_updater_v1_insights_search_jobs(id)
    ON DELETE CASCADE,
  install_key bytea NOT NULL CHECK (octet_length(install_key) = 32),
  PRIMARY KEY (job_id, install_key)
);

CREATE TABLE public.hot_updater_v1_insights_search_results (
  job_id text NOT NULL REFERENCES public.hot_updater_v1_insights_search_jobs(id)
    ON DELETE CASCADE,
  install_key bytea NOT NULL CHECK (octet_length(install_key) = 32),
  ordinal bigint NOT NULL CHECK (ordinal >= 0),
  install_id text NOT NULL,
  event jsonb NOT NULL,
  PRIMARY KEY (job_id, install_key),
  CONSTRAINT hot_updater_v1_insights_search_results_ordinal_key
    UNIQUE (job_id, ordinal)
);

CREATE TABLE public.hot_updater_v1_insights_publications (
  id text PRIMARY KEY,
  query jsonb NOT NULL,
  query_key bytea NOT NULL,
  source_id uuid NOT NULL,
  source_seq bigint NOT NULL,
  source_generation text NOT NULL,
  as_of_ms double precision NOT NULL,
  completed_at_ms double precision NOT NULL,
  visible boolean NOT NULL DEFAULT true,
  kind text NOT NULL,
  summary jsonb NOT NULL
);
CREATE INDEX hot_updater_v1_insights_publications_lookup_idx
  ON public.hot_updater_v1_insights_publications(
    query_key, as_of_ms DESC, source_seq DESC, id COLLATE "C" DESC
  );
CREATE UNIQUE INDEX hot_updater_v1_insights_publications_visible_key
  ON public.hot_updater_v1_insights_publications(
    query_key, source_id, source_seq, as_of_ms
  ) WHERE visible;

ALTER TABLE public.hot_updater_v1_insights_source_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hot_updater_v1_insights_live_installations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hot_updater_v1_insights_installation_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hot_updater_v1_insights_aliases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hot_updater_v1_insights_search_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hot_updater_v1_insights_search_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hot_updater_v1_insights_search_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hot_updater_v1_insights_publications ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION public.hot_updater_v1_insights_layout_digest(p_operation text)
RETURNS text
LANGUAGE sql
STABLE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  WITH expected_indexes(name) AS (
    SELECT unnest(CASE p_operation
      WHEN 'migration' THEN ARRAY[
        'hot_updater_v1_bundle_events_migration_idx',
        'hot_updater_v1_insights_source_state_pkey',
        'hot_updater_v1_insights_live_installations_pkey',
        'hot_updater_v1_insights_installation_versions_pkey',
        'hot_updater_v1_insights_aliases_scan_idx',
        'hot_updater_v1_insights_aliases_exact_idx',
        'hot_updater_v1_insights_aliases_identity_key'
      ]
      WHEN 'append' THEN ARRAY[
        'hot_updater_v1_bundle_events_pkey',
        'hot_updater_v1_bundle_events_source_seq_key',
        'hot_updater_v1_insights_live_installations_pkey',
        'hot_updater_v1_insights_installation_versions_pkey',
        'hot_updater_v1_insights_aliases_identity_key'
      ]
      WHEN 'event' THEN ARRAY[
        'hot_updater_v1_bundle_events_received_at_idx',
        'hot_updater_v1_bundle_events_install_type_idx',
        'hot_updater_v1_bundle_events_to_bundle_idx',
        'hot_updater_v1_bundle_events_from_bundle_idx'
      ]
      WHEN 'installation' THEN ARRAY[
        'hot_updater_v1_insights_live_installations_pkey',
        'hot_updater_v1_insights_installation_versions_pkey',
        'hot_updater_v1_insights_aliases_scan_idx',
        'hot_updater_v1_insights_aliases_exact_idx',
        'hot_updater_v1_insights_search_jobs_lookup_idx',
        'hot_updater_v1_insights_search_jobs_state_lookup_idx',
        'hot_updater_v1_insights_search_jobs_active_idx',
        'hot_updater_v1_insights_search_results_pkey',
        'hot_updater_v1_insights_search_results_ordinal_key'
      ]
      WHEN 'search' THEN ARRAY[
        'hot_updater_v1_bundle_events_pkey',
        'hot_updater_v1_insights_aliases_scan_idx',
        'hot_updater_v1_insights_aliases_exact_idx',
        'hot_updater_v1_insights_search_jobs_active_idx',
        'hot_updater_v1_insights_search_jobs_queue_idx',
        'hot_updater_v1_insights_search_members_pkey',
        'hot_updater_v1_insights_installation_versions_pkey',
        'hot_updater_v1_insights_search_results_pkey',
        'hot_updater_v1_insights_search_results_ordinal_key'
      ]
      WHEN 'report' THEN ARRAY[
        'hot_updater_v1_bundle_events_source_seq_key',
        'hot_updater_v1_insights_publications_lookup_idx',
        'hot_updater_v1_insights_publications_visible_key',
        'hot_updater_v1_insights_report_jobs_lookup_idx',
        'hot_updater_v1_insights_report_jobs_active_idx',
        'hot_updater_v1_insights_report_jobs_queue_idx',
        'hot_updater_v1_insights_report_latest_pkey',
        'hot_updater_v1_insights_report_counts_pkey',
        'hot_updater_v1_insights_report_counts_rank_idx',
        'hot_updater_v1_insights_report_counts_order_idx',
        'hot_updater_v1_insights_report_bundle_order_pkey',
        'hot_updater_v1_insights_report_bundle_order_bundle_key',
        'hot_updater_v1_insights_report_rows_pkey',
        'hot_updater_v1_insights_report_rows_bundle_idx',
        'hot_updater_v1_insights_report_totals_pkey'
      ]
      WHEN 'retention' THEN ARRAY[
        'hot_updater_v1_insights_search_jobs_pkey',
        'hot_updater_v1_insights_search_jobs_retention_idx',
        'hot_updater_v1_insights_search_members_pkey',
        'hot_updater_v1_insights_search_results_pkey',
        'hot_updater_v1_insights_search_results_ordinal_key',
        'hot_updater_v1_insights_publications_pkey',
        'hot_updater_v1_insights_report_jobs_pkey',
        'hot_updater_v1_insights_report_jobs_retention_idx',
        'hot_updater_v1_insights_report_members_pkey',
        'hot_updater_v1_insights_report_counts_pkey',
        'hot_updater_v1_insights_report_section_totals_pkey',
        'hot_updater_v1_insights_report_latest_pkey',
        'hot_updater_v1_insights_report_bundle_order_pkey',
        'hot_updater_v1_insights_report_rows_pkey',
        'hot_updater_v1_insights_report_totals_pkey'
      ]
      WHEN 'maintenance' THEN ARRAY[
        'hot_updater_v1_insights_source_state_pkey',
        'hot_updater_v1_insights_search_jobs_queue_idx',
        'hot_updater_v1_insights_report_jobs_queue_idx'
      ]
      ELSE ARRAY[]::text[]
    END)
  ), expected_relations(name) AS (
    SELECT unnest(CASE p_operation
      WHEN 'migration' THEN ARRAY[
        'hot_updater_v1_bundle_events',
        'hot_updater_v1_insights_source_state',
        'hot_updater_v1_insights_live_installations',
        'hot_updater_v1_insights_installation_versions',
        'hot_updater_v1_insights_aliases'
      ]
      WHEN 'append' THEN ARRAY[
        'hot_updater_v1_bundle_events',
        'hot_updater_v1_insights_source_state',
        'hot_updater_v1_insights_live_installations',
        'hot_updater_v1_insights_installation_versions',
        'hot_updater_v1_insights_aliases'
      ]
      WHEN 'event' THEN ARRAY[
        'hot_updater_v1_bundle_events',
        'hot_updater_v1_insights_source_state'
      ]
      WHEN 'installation' THEN ARRAY[
        'hot_updater_v1_insights_source_state',
        'hot_updater_v1_insights_live_installations',
        'hot_updater_v1_insights_installation_versions',
        'hot_updater_v1_insights_aliases',
        'hot_updater_v1_insights_search_jobs',
        'hot_updater_v1_insights_search_results'
      ]
      WHEN 'search' THEN ARRAY[
        'hot_updater_v1_bundle_events',
        'hot_updater_v1_insights_source_state',
        'hot_updater_v1_insights_aliases',
        'hot_updater_v1_insights_search_jobs',
        'hot_updater_v1_insights_search_members',
        'hot_updater_v1_insights_installation_versions',
        'hot_updater_v1_insights_search_results'
      ]
      WHEN 'report' THEN ARRAY[
        'hot_updater_v1_bundle_events',
        'hot_updater_v1_insights_source_state',
        'hot_updater_v1_insights_publications',
        'hot_updater_v1_insights_report_jobs',
        'hot_updater_v1_insights_report_members',
        'hot_updater_v1_insights_report_counts',
        'hot_updater_v1_insights_report_section_totals',
        'hot_updater_v1_insights_report_latest',
        'hot_updater_v1_insights_report_bundle_order',
        'hot_updater_v1_insights_report_rows',
        'hot_updater_v1_insights_report_totals'
      ]
      WHEN 'retention' THEN ARRAY[
        'hot_updater_v1_insights_source_state',
        'hot_updater_v1_insights_search_jobs',
        'hot_updater_v1_insights_search_members',
        'hot_updater_v1_insights_search_results',
        'hot_updater_v1_insights_publications',
        'hot_updater_v1_insights_report_jobs',
        'hot_updater_v1_insights_report_members',
        'hot_updater_v1_insights_report_counts',
        'hot_updater_v1_insights_report_section_totals',
        'hot_updater_v1_insights_report_latest',
        'hot_updater_v1_insights_report_bundle_order',
        'hot_updater_v1_insights_report_rows',
        'hot_updater_v1_insights_report_totals'
      ]
      WHEN 'maintenance' THEN ARRAY[
        'hot_updater_v1_insights_source_state',
        'hot_updater_v1_insights_search_jobs',
        'hot_updater_v1_insights_report_jobs'
      ]
      ELSE ARRAY[]::text[]
    END)
  ), expected_triggers(name) AS (
    SELECT unnest(CASE WHEN p_operation IN (
      'migration','append','event','installation','search','report'
    ) THEN ARRAY['hot_updater_v1_insights_fence_unsequenced_insert']
      ELSE ARRAY[]::text[] END)
  ), actual_indexes AS (
    SELECT expected.name, pg_get_indexdef(indexes.indexrelid) AS definition
    FROM expected_indexes AS expected
    JOIN pg_index AS indexes
      ON indexes.indexrelid = to_regclass('public.' || expected.name)
      AND indexes.indisvalid AND indexes.indisready
  ), actual_relations AS (
    SELECT expected.name, to_regclass('public.' || expected.name) AS oid
    FROM expected_relations AS expected
    WHERE to_regclass('public.' || expected.name) IS NOT NULL
  ), column_signatures AS (
    SELECT relation.name, string_agg(
      attribute.attnum::text || ':' || attribute.attname || ':' ||
        format_type(attribute.atttypid, attribute.atttypmod) || ':' ||
        attribute.attnotnull::text || ':' || attribute.attidentity::text || ':' ||
        attribute.attgenerated::text || ':' || coalesce(
          pg_get_expr(default_value.adbin, default_value.adrelid), ''
        ),
      ',' ORDER BY attribute.attnum
    ) AS definition
    FROM actual_relations AS relation
    JOIN pg_attribute AS attribute
      ON attribute.attrelid = relation.oid
      AND attribute.attnum > 0 AND NOT attribute.attisdropped
    LEFT JOIN pg_attrdef AS default_value
      ON default_value.adrelid = relation.oid
      AND default_value.adnum = attribute.attnum
    GROUP BY relation.name
  ), actual_triggers AS (
    SELECT expected.name,
      pg_get_triggerdef(trigger.oid, false) || ':' || trigger.tgenabled::text || ':' ||
        pg_get_functiondef(trigger.tgfoid) AS definition
    FROM expected_triggers AS expected
    JOIN pg_trigger AS trigger ON trigger.tgname=expected.name
      AND trigger.tgrelid=to_regclass('public.hot_updater_v1_bundle_events')
      AND NOT trigger.tgisinternal AND trigger.tgenabled='O'
  ), definitions AS (
    SELECT 'index:' || name AS name, definition FROM actual_indexes
    UNION ALL
    SELECT 'table:' || name, definition FROM column_signatures
    UNION ALL
    SELECT 'trigger:' || name, definition FROM actual_triggers
  )
  SELECT CASE
    WHEN (SELECT count(*) FROM expected_indexes) = 0
      OR (SELECT count(*) FROM actual_indexes) <>
        (SELECT count(*) FROM expected_indexes)
      OR (SELECT count(*) FROM actual_relations) <>
        (SELECT count(*) FROM expected_relations)
      OR (SELECT count(*) FROM column_signatures) <>
        (SELECT count(*) FROM expected_relations)
      OR (SELECT count(*) FROM actual_triggers) <>
        (SELECT count(*) FROM expected_triggers)
    THEN null
    ELSE encode(sha256(convert_to(string_agg(
      definitions.name || ':' || definitions.definition,
      E'\n' ORDER BY definitions.name
    ), 'utf8')), 'hex')
  END
  FROM definitions
$$;
REVOKE ALL ON FUNCTION public.hot_updater_v1_insights_layout_digest(text)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.hot_updater_v1_insights_layout_ready(p_operation text)
RETURNS boolean
LANGUAGE sql
STABLE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT coalesce(
    source.layout->>p_operation IS NOT NULL
      AND source.layout->>p_operation =
        public.hot_updater_v1_insights_layout_digest(p_operation),
    false
  )
  FROM public.hot_updater_v1_insights_source_state AS source
  WHERE source.id = 1 AND source.version = 2
$$;
REVOKE ALL ON FUNCTION public.hot_updater_v1_insights_layout_ready(text)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.hot_updater_v1_insights_search_lease_current(
  p_job_id text,
  p_lease_owner uuid,
  p_lease_epoch bigint
) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.hot_updater_v1_insights_search_jobs AS job
    WHERE job.id = p_job_id
      AND job.state = 'preparing'
      AND job.lease_owner = p_lease_owner
      AND job.lease_epoch = p_lease_epoch
      AND job.lease_expires_at_ms >=
        floor(extract(epoch FROM statement_timestamp()) * 1000)
  )
$$;

REVOKE ALL ON FUNCTION public.hot_updater_v1_insights_search_lease_current(
  text, uuid, bigint
) FROM PUBLIC, anon, authenticated, service_role;

INSERT INTO public.hot_updater_v1_private_settings (key, value)
VALUES ('schema.insights', 'supabase-insights-v2')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

CREATE FUNCTION public.hot_updater_v1_insights_prepare_read(
  p_database_namespace uuid,
  p_max_items integer
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_state public.hot_updater_v1_insights_source_state;
  v_batch jsonb;
  v_event public.hot_updater_v1_bundle_events;
  v_poison_id uuid;
BEGIN
  IF p_max_items IS NULL OR p_max_items NOT BETWEEN 0 AND 1000 THEN
    RAISE EXCEPTION 'Invalid Insights preparation input' USING ERRCODE = '22023';
  END IF;
  PERFORM public.hot_updater_v1_insights_bind_namespace(
    p_database_namespace
  );
  IF NOT coalesce(public.hot_updater_v1_insights_layout_ready('migration'), false)
  THEN
    RAISE EXCEPTION 'INSIGHTS_STORAGE_NOT_READY' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_state
  FROM public.hot_updater_v1_insights_source_state AS source
  WHERE source.id = 1 AND source.version = 2;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INSIGHTS_STORAGE_NOT_READY' USING ERRCODE = 'P0001';
  END IF;
  IF v_state.poison IS NOT NULL THEN
    IF p_max_items = 0 OR split_part(v_state.poison, ':', 1)
      NOT IN ('event', 'install-key')
    THEN
      RETURN jsonb_build_object(
        'state', 'failed', 'jobId', 'supabase-v2-migration',
        'sourceGeneration', jsonb_build_array(
          2, v_state.database_namespace, v_state.source_id,
          v_state.committed_seq
        )::text
      );
    END IF;
    BEGIN
      v_poison_id := split_part(v_state.poison, ':', 2)::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      v_poison_id := null;
    END;
    SELECT * INTO v_event
    FROM public.hot_updater_v1_bundle_events AS event
    WHERE event.id=v_poison_id AND event.insights_source_seq IS NULL;
    IF NOT FOUND THEN
      RETURN jsonb_build_object(
        'state', 'failed', 'jobId', 'supabase-v2-migration',
        'sourceGeneration', jsonb_build_array(
          2, v_state.database_namespace, v_state.source_id,
          v_state.committed_seq
        )::text
      );
    END IF;
  END IF;
  IF v_state.ready THEN
    RETURN jsonb_build_object(
      'state', 'ready',
      'sourceGeneration', jsonb_build_array(
        2, v_state.database_namespace, v_state.source_id,
        v_state.committed_seq
      )::text
    );
  END IF;
  IF p_max_items = 0 THEN
    RETURN jsonb_build_object(
      'state', 'preparing', 'jobId', 'supabase-v2-migration',
      'sourceGeneration', jsonb_build_array(
        2, v_state.database_namespace, v_state.source_id,
        v_state.committed_seq
      )::text
    );
  END IF;

  WITH candidates AS MATERIALIZED (
    SELECT event.id, event.install_id, event.user_id, event.username,
      event AS raw_event,
      octet_length(public.hot_updater_v1_insights_event_json(event)::text) + 64
        AS input_bytes
    FROM public.hot_updater_v1_bundle_events AS event
    WHERE event.insights_source_seq IS NULL
      AND (v_state.migration_after_id IS NULL OR
        event.id > v_state.migration_after_id)
    ORDER BY event.id
    LIMIT p_max_items
  ), measured AS (
    SELECT candidate.*,
      sum(candidate.input_bytes) OVER (ORDER BY candidate.id) AS cumulative_bytes
    FROM candidates AS candidate
  )
  SELECT jsonb_agg(jsonb_build_object(
    'id', measured.id,
    'installId', measured.install_id,
    'userId', measured.user_id,
    'username', measured.username,
    'event', public.hot_updater_v1_insights_event_json(measured.raw_event)
  ) ORDER BY measured.id) INTO v_batch
  FROM measured
  WHERE measured.cumulative_bytes <= 4194304;

  IF v_batch IS NULL THEN
    SELECT jsonb_build_array(jsonb_build_object(
      'id', event.id, 'oversized', true
    )) INTO v_batch
    FROM public.hot_updater_v1_bundle_events AS event
    WHERE event.insights_source_seq IS NULL
      AND (v_state.migration_after_id IS NULL OR
        event.id > v_state.migration_after_id)
    ORDER BY event.id
    LIMIT 1;
  END IF;

  RETURN jsonb_build_object(
    'state', 'preparing', 'jobId', 'supabase-v2-migration',
    'sourceGeneration', jsonb_build_array(
      2, v_state.database_namespace, v_state.source_id,
      v_state.committed_seq
    )::text,
    'batch', coalesce(v_batch, '[]'::jsonb)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.hot_updater_v1_insights_prepare_read(uuid, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hot_updater_v1_insights_prepare_read(uuid, integer)
  TO service_role;

CREATE FUNCTION public.hot_updater_v1_insights_prepare(
  p_database_namespace uuid,
  p_max_items integer,
  p_batch jsonb,
  p_batch_bytes integer
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_state public.hot_updater_v1_insights_source_state;
  v_event public.hot_updater_v1_bundle_events;
  v_id uuid;
  v_last_id uuid;
  v_seq bigint;
  v_install_key bytea;
  v_saved_install_id text;
  v_ids uuid[] := ARRAY[]::uuid[];
  v_candidate_ids uuid[];
  v_position integer;
  v_base_seq bigint;
  v_has_remaining boolean;
  v_processed integer := 0;
  v_batch_item jsonb;
  v_aliases jsonb;
  v_seen_keys bytea[] := ARRAY[]::bytea[];
  v_seen_ids text[] := ARRAY[]::text[];
  v_seen_position integer;
  v_invalid boolean;
  v_repair_poison text;
BEGIN
  IF p_max_items IS NULL OR p_max_items NOT BETWEEN 1 AND 1000
    OR jsonb_typeof(p_batch) <> 'array'
    OR jsonb_array_length(p_batch) NOT BETWEEN 1 AND p_max_items
    OR p_batch_bytes IS NULL OR p_batch_bytes NOT BETWEEN 1 AND 4194304
  THEN
    RAISE EXCEPTION 'Invalid Insights preparation input' USING ERRCODE = '22023';
  END IF;
  PERFORM public.hot_updater_v1_insights_bind_namespace(
    p_database_namespace
  );
  IF NOT coalesce(public.hot_updater_v1_insights_layout_ready('migration'), false)
  THEN
    RAISE EXCEPTION 'INSIGHTS_STORAGE_NOT_READY' USING ERRCODE = 'P0001';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('supabase-insights-migration-v2', 0)
  );
  SELECT * INTO v_state
  FROM public.hot_updater_v1_insights_source_state AS source
  WHERE source.id = 1 AND source.version = 2;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INSIGHTS_STORAGE_NOT_READY' USING ERRCODE = 'P0001';
  END IF;
  IF v_state.poison IS NOT NULL THEN
    v_repair_poison:=v_state.poison;
    IF split_part(v_repair_poison,':',1) NOT IN ('event','install-key')
      OR NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(p_batch) AS item
        WHERE item->>'id'=split_part(v_repair_poison,':',2)
      )
    THEN
      RETURN jsonb_build_object(
        'state', 'failed', 'jobId', 'supabase-v2-migration',
        'sourceGeneration', jsonb_build_array(
          2, v_state.database_namespace, v_state.source_id,
          v_state.committed_seq
        )::text
      );
    END IF;
  END IF;
  IF v_state.ready THEN
    RETURN jsonb_build_object(
      'state', 'ready',
      'sourceGeneration', jsonb_build_array(
        2, v_state.database_namespace, v_state.source_id,
        v_state.committed_seq
      )::text
    );
  END IF;

  FOR v_batch_item IN SELECT value FROM jsonb_array_elements(p_batch)
  LOOP
    IF jsonb_typeof(v_batch_item) <> 'object'
      OR v_batch_item->>'id' !~
        '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    THEN
      RAISE EXCEPTION 'Invalid Insights preparation input' USING ERRCODE = '22023';
    END IF;
    v_ids := array_append(v_ids, (v_batch_item->>'id')::uuid);
  END LOOP;

  SELECT array_agg(candidate.id ORDER BY candidate.id) INTO v_candidate_ids
  FROM (
    SELECT event.id
    FROM public.hot_updater_v1_bundle_events AS event
    WHERE event.insights_source_seq IS NULL
      AND (v_state.migration_after_id IS NULL OR
        event.id > v_state.migration_after_id)
    ORDER BY event.id
    LIMIT jsonb_array_length(p_batch)
  ) AS candidate;
  IF v_candidate_ids IS DISTINCT FROM v_ids THEN
    RETURN jsonb_build_object(
      'state', 'preparing', 'jobId', 'supabase-v2-migration',
      'sourceGeneration', jsonb_build_array(
        2, v_state.database_namespace, v_state.source_id,
        v_state.committed_seq
      )::text,
      'processed', 0, 'retry', true
    );
  END IF;

  v_position := 0;
  FOREACH v_id IN ARRAY coalesce(v_ids, ARRAY[]::uuid[])
  LOOP
    v_position := v_position + 1;
    v_batch_item := p_batch->(v_position - 1);
    SELECT * INTO v_event
    FROM public.hot_updater_v1_bundle_events AS event
    WHERE event.id = v_id AND event.insights_source_seq IS NULL
    FOR UPDATE;
    IF NOT FOUND THEN CONTINUE; END IF;

    v_invalid := coalesce(v_batch_item->>'invalid','false') = 'true'
      OR jsonb_typeof(v_batch_item->'eventBytes') <> 'number'
      OR v_batch_item->>'eventBytes' !~ '^(0|[1-9][0-9]*)$'
      OR (v_batch_item->>'eventBytes')::bigint > 20480;
    IF NOT v_invalid THEN
      v_event.insights_event_bytes := (v_batch_item->>'eventBytes')::integer;
      v_invalid := NOT public.hot_updater_v1_insights_event_matches_row(v_event);
    END IF;
    IF v_invalid THEN
      UPDATE public.hot_updater_v1_insights_source_state
      SET ready = false, poison = 'event:' || v_event.id::text
      WHERE id = 1
      RETURNING * INTO v_state;
      RETURN jsonb_build_object(
        'state', 'failed', 'jobId', 'supabase-v2-migration',
        'sourceGeneration', jsonb_build_array(
          2, v_state.database_namespace, v_state.source_id,
          v_state.committed_seq
        )::text
      );
    END IF;

    v_install_key := sha256(convert_to(
      to_jsonb(v_event.install_id)::text, 'utf8'
    ));
    v_seen_position := array_position(v_seen_keys, v_install_key);
    IF v_seen_position IS NOT NULL AND
      v_seen_ids[v_seen_position] <> v_event.install_id
    THEN
      UPDATE public.hot_updater_v1_insights_source_state
      SET ready = false, poison = 'install-key:' || v_event.id::text
      WHERE id = 1
      RETURNING * INTO v_state;
      RETURN jsonb_build_object(
        'state', 'failed', 'jobId', 'supabase-v2-migration',
        'sourceGeneration', jsonb_build_array(
          2, v_state.database_namespace, v_state.source_id,
          v_state.committed_seq
        )::text
      );
    END IF;
    v_seen_keys := array_append(v_seen_keys, v_install_key);
    v_seen_ids := array_append(v_seen_ids, v_event.install_id);
    SELECT live.install_id INTO v_saved_install_id
    FROM public.hot_updater_v1_insights_live_installations AS live
    WHERE live.install_key = v_install_key;
    IF FOUND AND v_saved_install_id <> v_event.install_id THEN
      UPDATE public.hot_updater_v1_insights_source_state
      SET ready = false, poison = 'install-key:' || v_event.id::text
      WHERE id = 1
      RETURNING * INTO v_state;
      RETURN jsonb_build_object(
        'state', 'failed', 'jobId', 'supabase-v2-migration',
        'sourceGeneration', jsonb_build_array(
          2, v_state.database_namespace, v_state.source_id,
          v_state.committed_seq
        )::text
      );
    END IF;

    v_aliases := v_batch_item->'aliases';
    IF jsonb_typeof(v_aliases) <> 'array'
      OR jsonb_array_length(v_aliases) <>
        1 + (v_event.user_id IS NOT NULL)::integer +
          (v_event.username IS NOT NULL)::integer
      OR NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(v_aliases) AS alias
        WHERE alias->>'kind' = 'installationId'
          AND alias->>'original' = v_event.install_id
          AND jsonb_typeof(alias->'normalized') = 'string'
      )
      OR (v_event.user_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(v_aliases) AS alias
        WHERE alias->>'kind' = 'userId'
          AND alias->>'original' = v_event.user_id
          AND jsonb_typeof(alias->'normalized') = 'string'
      ))
      OR (v_event.username IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(v_aliases) AS alias
        WHERE alias->>'kind' = 'username'
          AND alias->>'original' = v_event.username
          AND jsonb_typeof(alias->'normalized') = 'string'
      ))
      OR EXISTS (
        SELECT 1 FROM jsonb_array_elements(v_aliases) AS alias
        WHERE jsonb_typeof(alias) <> 'object'
          OR alias->>'kind' NOT IN ('installationId', 'userId', 'username')
          OR jsonb_typeof(alias->'original') <> 'string'
          OR jsonb_typeof(alias->'normalized') <> 'string'
          OR octet_length(convert_to(alias->>'normalized', 'utf8')) > 16384
          OR CASE alias->>'kind'
            WHEN 'installationId' THEN
              alias->>'original' <> v_event.install_id
            WHEN 'userId' THEN
              alias->>'original' IS DISTINCT FROM v_event.user_id
            WHEN 'username' THEN
              alias->>'original' IS DISTINCT FROM v_event.username
            ELSE true
          END
      )
    THEN
      UPDATE public.hot_updater_v1_insights_source_state
      SET ready = false, poison = 'event:' || v_event.id::text
      WHERE id = 1
      RETURNING * INTO v_state;
      RETURN jsonb_build_object(
        'state', 'failed', 'jobId', 'supabase-v2-migration',
        'sourceGeneration', jsonb_build_array(
          2, v_state.database_namespace, v_state.source_id,
          v_state.committed_seq
        )::text
      );
    END IF;

    v_last_id := v_event.id;
    v_processed := v_processed + 1;
  END LOOP;

  IF v_processed > 0 THEN
    IF v_repair_poison IS NOT NULL THEN
      UPDATE public.hot_updater_v1_insights_source_state AS source
      SET poison=null
      WHERE source.id=1 AND source.version=2
        AND source.poison=v_repair_poison;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'INSIGHTS_MIGRATION_REPLAY' USING ERRCODE='P0001';
      END IF;
    END IF;
    SELECT * INTO v_state
    FROM public.hot_updater_v1_insights_source_state AS source
    WHERE source.id = 1 AND source.version = 2 AND source.poison IS NULL
    FOR UPDATE;
    IF NOT FOUND OR v_state.ready THEN
      RAISE EXCEPTION 'INSIGHTS_MIGRATION_REPLAY' USING ERRCODE = 'P0001';
    END IF;
    UPDATE public.hot_updater_v1_insights_source_state
    SET committed_seq = committed_seq + v_processed
    WHERE id = 1 AND version = 2 AND poison IS NULL
    RETURNING committed_seq - v_processed INTO v_base_seq;
    IF v_base_seq IS NULL THEN
      RAISE EXCEPTION 'INSIGHTS_MIGRATION_REPLAY' USING ERRCODE = 'P0001';
    END IF;

    v_position := 0;
    FOREACH v_id IN ARRAY v_ids
    LOOP
      SELECT * INTO v_event
      FROM public.hot_updater_v1_bundle_events AS event
      WHERE event.id = v_id AND event.insights_source_seq IS NULL
      FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'INSIGHTS_MIGRATION_REPLAY' USING ERRCODE = 'P0001';
      END IF;
      v_position := v_position + 1;
      v_seq := v_base_seq + v_position;
      v_install_key := sha256(convert_to(
        to_jsonb(v_event.install_id)::text, 'utf8'
      ));
      SELECT live.install_id INTO v_saved_install_id
      FROM public.hot_updater_v1_insights_live_installations AS live
      WHERE live.install_key = v_install_key;
      IF FOUND AND v_saved_install_id <> v_event.install_id THEN
        RAISE EXCEPTION 'INSIGHTS_STORAGE_CORRUPTION' USING ERRCODE = 'P0001';
      END IF;
    UPDATE public.hot_updater_v1_bundle_events
    SET insights_source_seq = v_seq,
      insights_event_bytes =
        (p_batch->(v_position - 1)->>'eventBytes')::integer,
      insights_install_key = v_install_key,
      insights_cohort_order =
        public.hot_updater_v1_insights_js_order(v_event.cohort)
    WHERE id = v_event.id AND insights_source_seq IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'INSIGHTS_MIGRATION_REPLAY' USING ERRCODE = 'P0001';
    END IF;

    INSERT INTO public.hot_updater_v1_insights_live_installations (
      install_key, install_id, event_id, received_at_ms, source_seq, event
    ) VALUES (
      v_install_key, v_event.install_id, v_event.id, v_event.received_at_ms,
      v_seq, public.hot_updater_v1_insights_event_json(v_event)
    )
    ON CONFLICT (install_key) DO UPDATE SET
      event_id = EXCLUDED.event_id,
      received_at_ms = EXCLUDED.received_at_ms,
      source_seq = EXCLUDED.source_seq,
      event = EXCLUDED.event
    WHERE public.hot_updater_v1_insights_live_installations.install_id =
        EXCLUDED.install_id
      AND (
        public.hot_updater_v1_insights_live_installations.received_at_ms,
        public.hot_updater_v1_insights_live_installations.event_id
      ) < (EXCLUDED.received_at_ms, EXCLUDED.event_id);

    INSERT INTO public.hot_updater_v1_insights_installation_versions (
      install_key, source_seq, event_id
    )
    SELECT v_install_key, v_seq, live.event_id
    FROM public.hot_updater_v1_insights_live_installations AS live
    WHERE live.install_key = v_install_key;

    PERFORM public.hot_updater_v1_insights_insert_alias(
      v_seq, v_install_key, v_event.install_id, alias->>'kind',
      alias->>'original', alias->>'normalized'
    )
    FROM jsonb_array_elements(
      p_batch->(v_position - 1)->'aliases'
    ) AS alias;

    END LOOP;
    v_state.committed_seq := v_base_seq + v_processed;
  END IF;

  IF v_last_id IS NOT NULL THEN
    UPDATE public.hot_updater_v1_insights_source_state
    SET migration_after_id = v_last_id
    WHERE id = 1 AND poison IS NULL;
    v_state.migration_after_id := v_last_id;
  END IF;
  SELECT EXISTS (
    SELECT 1 FROM public.hot_updater_v1_bundle_events AS event
    WHERE event.insights_source_seq IS NULL
      AND (v_state.migration_after_id IS NULL OR
        event.id > v_state.migration_after_id)
    LIMIT 1
  ) INTO v_has_remaining;

  IF v_processed = 0 AND v_has_remaining THEN
    SELECT event.id INTO v_id
    FROM public.hot_updater_v1_bundle_events AS event
    WHERE event.insights_source_seq IS NULL
      AND (v_state.migration_after_id IS NULL OR
        event.id > v_state.migration_after_id)
    ORDER BY event.id LIMIT 1;
    UPDATE public.hot_updater_v1_insights_source_state
    SET poison = 'event:' || v_id::text, ready = false WHERE id = 1
    RETURNING * INTO v_state;
    RETURN jsonb_build_object(
      'state', 'failed', 'jobId', 'supabase-v2-migration',
      'sourceGeneration', jsonb_build_array(
        2, v_state.database_namespace, v_state.source_id,
        v_state.committed_seq
      )::text
    );
  END IF;

  IF NOT v_has_remaining AND EXISTS (
    SELECT 1 FROM public.hot_updater_v1_bundle_events AS event
    WHERE event.insights_source_seq IS NULL LIMIT 1
  ) THEN
    UPDATE public.hot_updater_v1_insights_source_state
    SET poison = 'migration-order', ready = false WHERE id = 1
    RETURNING * INTO v_state;
    RETURN jsonb_build_object(
      'state', 'failed', 'jobId', 'supabase-v2-migration',
      'sourceGeneration', jsonb_build_array(
        2, v_state.database_namespace, v_state.source_id,
        v_state.committed_seq
      )::text
    );
  END IF;
  IF NOT v_has_remaining THEN
    UPDATE public.hot_updater_v1_insights_source_state
    SET ready = true WHERE id = 1 AND poison IS NULL;
  END IF;

  RETURN jsonb_build_object(
    'state', CASE WHEN v_has_remaining THEN 'preparing' ELSE 'ready' END,
    'jobId', CASE WHEN v_has_remaining THEN 'supabase-v2-migration' ELSE null END,
    'sourceGeneration', jsonb_build_array(
      2, v_state.database_namespace, v_state.source_id,
      v_state.committed_seq
    )::text,
    'processed', v_processed
  );
END;
$$;

REVOKE ALL ON FUNCTION public.hot_updater_v1_insights_prepare(
  uuid, integer, jsonb, integer
)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hot_updater_v1_insights_prepare(
  uuid, integer, jsonb, integer
)
  TO service_role;

CREATE FUNCTION public.hot_updater_v1_insights_append(
  p_database_namespace uuid,
  p_event jsonb,
  p_event_bytes integer,
  p_install_key text,
  p_cohort_order text,
  p_aliases jsonb
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_event public.hot_updater_v1_bundle_events;
  v_seq bigint;
  v_expected_key bytea;
  v_alias jsonb;
  v_saved_install_id text;
BEGIN
  IF jsonb_typeof(p_event) <> 'object'
    OR p_event->>'id' !~
      '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    OR p_event_bytes IS NULL OR p_event_bytes NOT BETWEEN 0 AND 20480
    OR p_install_key !~ '^[0-9a-f]{64}$'
    OR p_cohort_order !~ '^(?:[0-9a-f]{4})*$'
    OR jsonb_typeof(p_aliases) <> 'array'
    OR jsonb_array_length(p_aliases) NOT BETWEEN 1 AND 3
  THEN
    RAISE EXCEPTION 'Invalid Insights append' USING ERRCODE = '22023';
  END IF;
  PERFORM public.hot_updater_v1_insights_bind_namespace(
    p_database_namespace
  );
  IF NOT coalesce(public.hot_updater_v1_insights_layout_ready('append'), false)
  THEN
    RAISE EXCEPTION 'INSIGHTS_STORAGE_NOT_READY' USING ERRCODE='P0001';
  END IF;

  v_event := jsonb_populate_record(NULL::public.hot_updater_v1_bundle_events, p_event);
  v_expected_key := sha256(convert_to(to_jsonb(v_event.install_id)::text, 'utf8'));
  IF encode(v_expected_key, 'hex') <> p_install_key
    OR decode(p_cohort_order, 'hex') <>
      public.hot_updater_v1_insights_js_order(v_event.cohort)
    OR v_event.received_at_ms <> trunc(v_event.received_at_ms)
    OR v_event.received_at_ms > 9007199254740991
    OR octet_length(public.hot_updater_v1_insights_js_order(v_event.install_id)) > 2048
    OR (v_event.user_id IS NOT NULL AND octet_length(
      public.hot_updater_v1_insights_js_order(v_event.user_id)) > 2048)
    OR (v_event.username IS NOT NULL AND octet_length(
      public.hot_updater_v1_insights_js_order(v_event.username)) > 2048)
    OR octet_length(public.hot_updater_v1_insights_js_order(v_event.app_version)) > 2048
    OR octet_length(public.hot_updater_v1_insights_js_order(v_event.channel)) > 2048
    OR octet_length(public.hot_updater_v1_insights_js_order(v_event.cohort)) > 2048
    OR (v_event.fingerprint_hash IS NOT NULL AND octet_length(
      public.hot_updater_v1_insights_js_order(v_event.fingerprint_hash)) > 2048)
    OR (v_event.sdk_version IS NOT NULL AND octet_length(
      public.hot_updater_v1_insights_js_order(v_event.sdk_version)) > 2048)
    OR jsonb_array_length(p_aliases) <>
      1 + (v_event.user_id IS NOT NULL)::integer +
        (v_event.username IS NOT NULL)::integer
    OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_aliases) AS alias
      WHERE alias->>'kind' = 'installationId')
    OR (v_event.user_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_aliases) AS alias
      WHERE alias->>'kind' = 'userId'))
    OR (v_event.username IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_aliases) AS alias
      WHERE alias->>'kind' = 'username'))
  THEN
    RAISE EXCEPTION 'Invalid installation projection' USING ERRCODE = '22023';
  END IF;
  IF NOT coalesce(public.hot_updater_v1_insights_layout_ready('append'), false)
  THEN
    RAISE EXCEPTION 'INSIGHTS_STORAGE_NOT_READY' USING ERRCODE = 'P0001';
  END IF;

  SELECT live.install_id INTO v_saved_install_id
  FROM public.hot_updater_v1_insights_live_installations AS live
  WHERE live.install_key = v_expected_key;
  IF FOUND AND v_saved_install_id <> v_event.install_id THEN
    RAISE EXCEPTION 'INSIGHTS_STORAGE_CORRUPTION' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.hot_updater_v1_insights_source_state
  SET committed_seq = committed_seq + 1
  WHERE id = 1 AND version = 2
  RETURNING committed_seq INTO v_seq;
  IF v_seq IS NULL THEN
    RAISE EXCEPTION 'INSIGHTS_STORAGE_NOT_READY' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.hot_updater_v1_bundle_events (
    id, type, install_id, user_id, username, from_release_id,
    from_bundle_id, to_release_id, to_bundle_id, platform, app_version,
    channel, cohort, update_strategy, fingerprint_hash, sdk_version,
    received_at_ms, insights_event, insights_source_seq, insights_install_key,
    insights_cohort_order, insights_event_bytes
  ) VALUES (
    v_event.id, v_event.type, v_event.install_id, v_event.user_id,
    v_event.username, v_event.from_release_id, v_event.from_bundle_id,
    v_event.to_release_id, v_event.to_bundle_id, v_event.platform,
    v_event.app_version, v_event.channel, v_event.cohort,
    v_event.update_strategy, v_event.fingerprint_hash, v_event.sdk_version,
    v_event.received_at_ms, p_event, v_seq, v_expected_key,
    decode(p_cohort_order, 'hex'), p_event_bytes
  );

  INSERT INTO public.hot_updater_v1_insights_live_installations (
    install_key, install_id, event_id, received_at_ms, source_seq, event
  ) VALUES (
    v_expected_key, v_event.install_id, v_event.id, v_event.received_at_ms,
    v_seq, p_event
  )
  ON CONFLICT (install_key) DO UPDATE SET
    event_id = EXCLUDED.event_id,
    received_at_ms = EXCLUDED.received_at_ms,
    source_seq = EXCLUDED.source_seq,
    event = EXCLUDED.event
  WHERE public.hot_updater_v1_insights_live_installations.install_id =
      EXCLUDED.install_id
    AND (
      public.hot_updater_v1_insights_live_installations.received_at_ms,
      public.hot_updater_v1_insights_live_installations.event_id
    ) < (EXCLUDED.received_at_ms, EXCLUDED.event_id);

  INSERT INTO public.hot_updater_v1_insights_installation_versions (
    install_key, source_seq, event_id
  )
  SELECT v_expected_key, v_seq, live.event_id
  FROM public.hot_updater_v1_insights_live_installations AS live
  WHERE live.install_key = v_expected_key;

  FOR v_alias IN SELECT value FROM jsonb_array_elements(p_aliases)
  LOOP
    IF jsonb_typeof(v_alias) <> 'object'
      OR v_alias->>'kind' NOT IN ('installationId', 'userId', 'username')
      OR v_alias->>'original' IS NULL
      OR v_alias->>'normalized' IS NULL
      OR octet_length(public.hot_updater_v1_insights_js_order(
        v_alias->>'original')) > 2048
      OR octet_length(convert_to(v_alias->>'normalized', 'utf8')) > 16384
      OR (CASE v_alias->>'kind'
        WHEN 'installationId' THEN v_alias->>'original' <> v_event.install_id
        WHEN 'userId' THEN v_alias->>'original' IS DISTINCT FROM v_event.user_id
        WHEN 'username' THEN v_alias->>'original' IS DISTINCT FROM v_event.username
        ELSE true
      END)
    THEN
      RAISE EXCEPTION 'Invalid Insights alias' USING ERRCODE = '22023';
    END IF;
    PERFORM public.hot_updater_v1_insights_insert_alias(
      v_seq, v_expected_key, v_event.install_id, v_alias->>'kind',
      v_alias->>'original', v_alias->>'normalized'
    );
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.hot_updater_v1_insights_append(
  uuid, jsonb, integer, text, text, jsonb
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hot_updater_v1_insights_append(
  uuid, jsonb, integer, text, text, jsonb
) TO service_role;
REVOKE INSERT, UPDATE, DELETE ON public.hot_updater_v1_bundle_events
  FROM service_role;

CREATE OR REPLACE FUNCTION public.hot_updater_v1_insights_event_page(
  p_database_namespace uuid,
  p_scope text,
  p_scope_id text,
  p_before_received_at_ms double precision,
  p_since_received_at_ms double precision,
  p_limit integer,
  p_cursor_received_at_ms double precision DEFAULT NULL,
  p_cursor_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_indexes jsonb;
  v_boundary_ms double precision;
  v_boundary_id uuid;
  v_bundle_id uuid;
  v_install_key bytea;
  v_source_seq bigint;
  v_source_generation text;
  v_result jsonb;
BEGIN
  IF p_scope IS NULL OR p_scope NOT IN ('all', 'installation', 'bundle')
    OR p_limit IS NULL OR p_limit < 1 OR p_limit > 100
    OR p_before_received_at_ms IS NULL
    OR NOT (p_before_received_at_ms BETWEEN 0 AND 9007199254740991
      AND p_before_received_at_ms = trunc(p_before_received_at_ms))
    OR p_since_received_at_ms IS NULL
    OR NOT (p_since_received_at_ms BETWEEN 0 AND p_before_received_at_ms
      AND p_since_received_at_ms = trunc(p_since_received_at_ms))
    OR (p_scope = 'all' AND p_scope_id IS NOT NULL)
    OR (p_scope <> 'all' AND (p_scope_id IS NULL
      OR char_length(p_scope_id) > 1024))
    OR ((p_cursor_received_at_ms IS NULL) <> (p_cursor_id IS NULL))
    OR (p_cursor_id IS NOT NULL AND p_cursor_id::text !~
      '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
  THEN
    RAISE EXCEPTION 'Invalid Insights event page input' USING ERRCODE = '22023';
  END IF;
  PERFORM public.hot_updater_v1_insights_require_namespace(
    p_database_namespace
  );
  IF NOT coalesce(public.hot_updater_v1_insights_layout_ready('event'), false)
  THEN
    RAISE EXCEPTION 'INSIGHTS_STORAGE_NOT_READY' USING ERRCODE = 'P0001';
  END IF;

  SELECT source.committed_seq,
    jsonb_build_array(
      2, source.database_namespace, source.source_id, source.committed_seq
    )::text
  INTO v_source_seq, v_source_generation
  FROM public.hot_updater_v1_insights_source_state AS source
  WHERE source.id = 1 AND source.version = 2 AND source.ready
    AND source.poison IS NULL;
  IF v_source_generation IS NULL THEN
    RAISE EXCEPTION 'INSIGHTS_STORAGE_NOT_READY' USING ERRCODE = 'P0001';
  END IF;

  SELECT coalesce(jsonb_agg(to_jsonb(layout.columns)), '[]'::jsonb)
  INTO v_indexes
  FROM (
    SELECT ARRAY(SELECT pg_get_indexdef(i.indexrelid, n, false)
      FROM generate_series(1, i.indnkeyatts) n) AS columns
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_am am ON am.oid = c.relam
    WHERE i.indrelid = to_regclass('public.hot_updater_v1_bundle_events')
      AND i.indisvalid AND i.indisready
      AND i.indpred IS NULL AND i.indexprs IS NULL AND am.amname = 'btree'
  ) AS layout;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(CASE p_scope
      WHEN 'all' THEN '[["received_at_ms", "id"]]'::jsonb
      WHEN 'installation' THEN
        '[["insights_install_key", "type", "received_at_ms", "id"]]'::jsonb
      ELSE '[["type", "to_bundle_id", "received_at_ms", "id"],
        ["type", "from_bundle_id", "received_at_ms", "id"]]'::jsonb
    END) AS required(columns)
    WHERE NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_indexes) AS actual(columns)
      WHERE actual.columns = required.columns
    )
  ) THEN
    RAISE EXCEPTION 'INSIGHTS_STORAGE_NOT_READY' USING ERRCODE = 'P0001';
  END IF;

  v_boundary_ms := coalesce(p_cursor_received_at_ms, p_before_received_at_ms);
  v_boundary_id := coalesce(
    p_cursor_id,
    '00000000-0000-0000-0000-000000000000'::uuid
  );
  IF p_scope = 'bundle' THEN
    v_bundle_id := p_scope_id::uuid;
  ELSIF p_scope = 'installation' THEN
    v_install_key:=sha256(convert_to(to_jsonb(p_scope_id)::text,'utf8'));
  END IF;

  v_result := (
    WITH candidates AS MATERIALIZED (
      (SELECT event.* FROM public.hot_updater_v1_bundle_events AS event
        WHERE p_scope = 'all'
          AND event.received_at_ms >= p_since_received_at_ms
          AND (event.received_at_ms, event.id) < (v_boundary_ms, v_boundary_id)
        ORDER BY event.received_at_ms DESC, event.id DESC LIMIT p_limit + 1)
      UNION ALL
      (SELECT event.* FROM public.hot_updater_v1_bundle_events AS event
        WHERE p_scope = 'installation'
          AND event.received_at_ms >= p_since_received_at_ms
          AND event.insights_install_key = v_install_key
          AND event.type = 'UPDATE_APPLIED'
          AND (event.received_at_ms, event.id) < (v_boundary_ms, v_boundary_id)
        ORDER BY event.received_at_ms DESC, event.id DESC LIMIT p_limit + 1)
      UNION ALL
      (SELECT event.* FROM public.hot_updater_v1_bundle_events AS event
        WHERE p_scope = 'installation'
          AND event.received_at_ms >= p_since_received_at_ms
          AND event.insights_install_key = v_install_key
          AND event.type = 'RECOVERED'
          AND (event.received_at_ms, event.id) < (v_boundary_ms, v_boundary_id)
        ORDER BY event.received_at_ms DESC, event.id DESC LIMIT p_limit + 1)
      UNION ALL
      (SELECT event.* FROM public.hot_updater_v1_bundle_events AS event
        WHERE p_scope = 'bundle'
          AND event.received_at_ms >= p_since_received_at_ms
          AND event.to_bundle_id = v_bundle_id
          AND event.type = 'UPDATE_APPLIED'
          AND (event.received_at_ms, event.id) < (v_boundary_ms, v_boundary_id)
        ORDER BY event.received_at_ms DESC, event.id DESC LIMIT p_limit + 1)
      UNION ALL
      (SELECT event.* FROM public.hot_updater_v1_bundle_events AS event
        WHERE p_scope = 'bundle'
          AND event.received_at_ms >= p_since_received_at_ms
          AND event.from_bundle_id = v_bundle_id
          AND event.type = 'RECOVERED'
          AND (event.received_at_ms, event.id) < (v_boundary_ms, v_boundary_id)
        ORDER BY event.received_at_ms DESC, event.id DESC LIMIT p_limit + 1)
    ), ordered AS (
      SELECT candidate.*,
        public.hot_updater_v1_insights_event_json(candidate) AS event_json,
        sum(greatest(
          candidate.insights_event_bytes,
          octet_length(public.hot_updater_v1_insights_event_json(candidate)::text)
        ) + 1) OVER (
          ORDER BY candidate.received_at_ms DESC, candidate.id DESC
        ) AS cumulative_bytes
      FROM candidates AS candidate
    ), page AS (
      SELECT * FROM ordered
      WHERE cumulative_bytes <= 1030000
      ORDER BY received_at_ms DESC, id DESC
      LIMIT p_limit
    )
    SELECT jsonb_build_object(
      'rows', coalesce((SELECT jsonb_agg(
        page.event_json
        ORDER BY page.received_at_ms DESC, page.id DESC
      ) FROM page), '[]'::jsonb),
      'hasMore', (SELECT count(*) FROM candidates) >
        (SELECT count(*) FROM page),
      'candidateReads', (SELECT count(*) FROM candidates),
      'corrupt', EXISTS (
        SELECT 1 FROM candidates AS candidate
        WHERE public.hot_updater_v1_insights_event_matches_row(candidate)
            IS NOT TRUE
          OR candidate.insights_source_seq IS NULL
          OR candidate.insights_source_seq NOT BETWEEN 1 AND v_source_seq
          OR candidate.insights_install_key IS DISTINCT FROM sha256(convert_to(
            to_jsonb(candidate.install_id)::text,'utf8'
          ))
          OR candidate.insights_cohort_order IS DISTINCT FROM
            public.hot_updater_v1_insights_js_order(candidate.cohort)
          OR (p_scope='installation' AND candidate.install_id<>p_scope_id)
      ),
      'sourceGeneration', v_source_generation
    )
  );
  IF (v_result->>'corrupt')::boolean THEN
    RAISE EXCEPTION 'INSIGHTS_STORAGE_CORRUPTION' USING ERRCODE='P0001';
  END IF;
  RETURN v_result-'corrupt';
END;
$$;

REVOKE ALL ON FUNCTION public.hot_updater_v1_insights_event_page(
  uuid, text, text, double precision, double precision, integer,
  double precision, uuid
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hot_updater_v1_insights_event_page(
  uuid, text, text, double precision, double precision, integer,
  double precision, uuid
) TO service_role;

CREATE FUNCTION public.hot_updater_v1_insights_installation_row(p_event jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog
AS $$
  SELECT jsonb_build_object(
    'id', p_event->'id',
    'install_id', p_event->'install_id',
    'user_id', p_event->'user_id',
    'username', p_event->'username',
    'to_bundle_id', p_event->'to_bundle_id',
    'type', p_event->'type',
    'platform', p_event->'platform',
    'app_version', p_event->'app_version',
    'channel', p_event->'channel',
    'cohort', p_event->'cohort',
    'received_at_ms', p_event->'received_at_ms'
  )
$$;

REVOKE ALL ON FUNCTION public.hot_updater_v1_insights_installation_row(jsonb)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.hot_updater_v1_insights_installation_page(
  p_database_namespace uuid,
  p_selector jsonb,
  p_limit integer,
  p_after_key text DEFAULT NULL,
  p_after_ordinal text DEFAULT NULL,
  p_publication_id text DEFAULT NULL,
  p_min_as_of_ms double precision DEFAULT NULL,
  p_now_ms double precision DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_kind text := p_selector->>'kind';
  v_source_id uuid;
  v_source_seq bigint;
  v_generation text;
  v_observed_at_ms double precision;
  v_after bytea;
  v_after_ordinal bigint := -1;
  v_job public.hot_updater_v1_insights_search_jobs;
  v_previous public.hot_updater_v1_insights_search_jobs;
  v_job_id text;
  v_query_key bytea;
  v_alias_upper_id bigint;
  v_step_last bigint;
  v_result_last bytea;
  v_step_count integer;
  v_inserted integer;
  v_has_remaining boolean;
  v_lease_owner uuid;
  v_lease_epoch bigint;
  v_refresh_job_id text;
  v_response_state text := 'ready';
  v_result jsonb;
  v_source_ready boolean;
  v_source_poison text;
BEGIN
  IF jsonb_typeof(p_selector) <> 'object'
    OR v_kind NOT IN ('all', 'installationId', 'userId', 'contains')
    OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100
    OR (p_after_key IS NOT NULL AND p_after_key !~ '^[0-9a-f]{64}$')
    OR (p_after_ordinal IS NOT NULL AND (
      p_after_ordinal !~ '^(0|[1-9][0-9]*)$'
      OR length(p_after_ordinal) > 19
      OR (length(p_after_ordinal)=19 AND
        p_after_ordinal > '9223372036854775807')
    ))
    OR (v_kind IN ('contains','userId') AND
      (p_after_key IS NULL) <> (p_after_ordinal IS NULL))
    OR (v_kind IN ('all','installationId') AND p_after_ordinal IS NOT NULL)
    OR (p_publication_id IS NOT NULL AND length(p_publication_id) > 128)
    OR (p_min_as_of_ms IS NOT NULL AND (
      p_min_as_of_ms < 0 OR p_min_as_of_ms > 9007199254740991 OR
      p_min_as_of_ms <> trunc(p_min_as_of_ms)
    ))
    OR (p_now_ms IS NOT NULL AND (
      p_now_ms < 0 OR p_now_ms > 9007199254740991 OR
      p_now_ms <> trunc(p_now_ms)
    ))
    OR (v_kind = 'installationId' AND (
      char_length(p_selector->>'installId') > 1024 OR
      p_selector->>'installId' IS NULL
    ))
    OR (v_kind = 'userId' AND (
      char_length(p_selector->>'userId') > 1024 OR
      p_selector->>'userId' IS NULL
    ))
    OR (v_kind = 'contains' AND (
      octet_length(convert_to(p_selector->>'query','utf8')) NOT BETWEEN 1 AND 16384
    ))
  THEN
    RAISE EXCEPTION 'Invalid installation page input' USING ERRCODE = '22023';
  END IF;
  PERFORM public.hot_updater_v1_insights_bind_namespace(
    p_database_namespace
  );
  IF NOT coalesce(
    public.hot_updater_v1_insights_layout_ready('installation'), false
  ) THEN
    RAISE EXCEPTION 'INSIGHTS_STORAGE_NOT_READY' USING ERRCODE = 'P0001';
  END IF;
  IF p_after_key IS NOT NULL THEN v_after := decode(p_after_key, 'hex'); END IF;
  IF p_after_ordinal IS NOT NULL THEN
    v_after_ordinal := p_after_ordinal::bigint;
  END IF;

  IF v_kind IN ('all', 'installationId') THEN
    v_result := (
      WITH source AS MATERIALIZED (
        SELECT jsonb_build_array(
            2, state.database_namespace, state.source_id,
            state.committed_seq
          )::text AS generation,
          coalesce(p_now_ms, floor(
            extract(epoch FROM clock_timestamp()) * 1000
          )::double precision) AS observed_at_ms
        FROM public.hot_updater_v1_insights_source_state AS state
        WHERE state.id = 1 AND state.version = 2 AND state.ready
          AND state.poison IS NULL
      ), candidates AS MATERIALIZED (
        SELECT live.*
        FROM public.hot_updater_v1_insights_live_installations AS live
        CROSS JOIN source
        WHERE (v_kind = 'all' AND (v_after IS NULL OR live.install_key > v_after))
          OR (v_kind = 'installationId'
            AND live.install_key = sha256(convert_to(
              to_jsonb(p_selector->>'installId')::text, 'utf8'
            )))
        ORDER BY live.install_key
        LIMIT p_limit + 1
      ), measured AS (
        SELECT candidate.*,
          sum(octet_length(public.hot_updater_v1_insights_canonical_json(
            public.hot_updater_v1_insights_installation_row(candidate.event)
          )) + 1) OVER (ORDER BY candidate.install_key) AS cumulative_bytes
        FROM candidates AS candidate
      ), page AS (
        SELECT * FROM measured WHERE cumulative_bytes <= 1039000
        ORDER BY install_key LIMIT p_limit
      )
      SELECT jsonb_build_object(
        'state', 'ready',
        'rows', coalesce((SELECT jsonb_agg(
          public.hot_updater_v1_insights_installation_row(page.event)
          ORDER BY page.install_key
        ) FROM page), '[]'::jsonb),
        'hasMore', (SELECT count(*) FROM candidates) >
          (SELECT count(*) FROM page),
        'candidateReads', (SELECT count(*) FROM candidates),
        'lastKey', (SELECT encode(page.install_key, 'hex') FROM page
          ORDER BY page.install_key DESC LIMIT 1),
        'consistency', 'live',
        'observedAtMs', (SELECT observed_at_ms FROM source),
        'sourceGeneration', (SELECT generation FROM source),
        'sourceMissing', NOT EXISTS (SELECT 1 FROM source),
        'total', null,
        'corrupt', EXISTS (SELECT 1 FROM candidates AS candidate
          WHERE candidate.install_key <>
              sha256(convert_to(to_jsonb(candidate.install_id)::text, 'utf8'))
            OR (v_kind = 'installationId'
              AND candidate.install_id <> p_selector->>'installId')
            OR candidate.event->>'install_id' <> candidate.install_id
            OR candidate.event->>'id' <> candidate.event_id::text)
      )
    );
    IF (v_result->>'sourceMissing')::boolean THEN
      RAISE EXCEPTION 'INSIGHTS_STORAGE_NOT_READY' USING ERRCODE = 'P0001';
    END IF;
    IF (v_result->>'corrupt')::boolean THEN
      RAISE EXCEPTION 'INSIGHTS_STORAGE_CORRUPTION' USING ERRCODE = 'P0001';
    END IF;
    RETURN v_result - 'corrupt' - 'sourceMissing';
  END IF;

  IF p_publication_id IS NOT NULL THEN
    SELECT * INTO v_job
    FROM public.hot_updater_v1_insights_search_jobs AS job
    WHERE job.id = p_publication_id
    FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object(
        'state', 'expired', 'publicationId', p_publication_id
      );
    END IF;
    IF v_job.state <> 'ready' OR NOT v_job.visible THEN
      RETURN jsonb_build_object(
        'state', 'expired', 'publicationId', p_publication_id
      );
    END IF;
    IF v_job.selector <> p_selector THEN
      RETURN jsonb_build_object(
        'state', 'expired', 'publicationId', p_publication_id
      );
    END IF;
    IF p_min_as_of_ms IS NOT NULL AND v_job.as_of_ms < p_min_as_of_ms THEN
      RETURN jsonb_build_object(
        'state', 'expired', 'publicationId', p_publication_id
      );
    END IF;
  ELSE
    v_query_key := sha256(convert_to(
      'supabase-search-semantics-v2:' || p_selector::text, 'utf8'
    ));
    PERFORM pg_advisory_xact_lock(
      hashtextextended(encode(v_query_key, 'hex'), 0)
    );
    SELECT * INTO v_job
    FROM public.hot_updater_v1_insights_search_jobs AS job
    WHERE job.query_key = v_query_key AND job.state = 'ready' AND job.visible
      AND (p_min_as_of_ms IS NULL OR job.as_of_ms >= p_min_as_of_ms)
    ORDER BY job.as_of_ms DESC, job.id COLLATE "C" DESC LIMIT 1;
    IF NOT FOUND THEN
      IF p_min_as_of_ms IS NOT NULL THEN
        SELECT * INTO v_previous
        FROM public.hot_updater_v1_insights_search_jobs AS job
        WHERE job.query_key = v_query_key AND job.state = 'ready' AND job.visible
        ORDER BY job.as_of_ms DESC, job.id COLLATE "C" DESC LIMIT 1;
      END IF;
      SELECT * INTO v_job
      FROM public.hot_updater_v1_insights_search_jobs AS job
      WHERE job.query_key = v_query_key
        AND job.state IN ('preparing', 'failed') AND job.visible
      ORDER BY job.as_of_ms DESC, job.id COLLATE "C" DESC LIMIT 1 FOR UPDATE;
    END IF;
    IF NOT FOUND THEN
      SELECT source.source_id, source.committed_seq,
        jsonb_build_array(
          2, source.database_namespace, source.source_id, source.committed_seq
        )::text,
        coalesce(p_now_ms,
          floor(extract(epoch FROM clock_timestamp()) * 1000)::double precision),
        source.ready, source.poison
      INTO v_source_id, v_source_seq, v_generation, v_observed_at_ms,
        v_source_ready, v_source_poison
      FROM public.hot_updater_v1_insights_source_state AS source
      WHERE source.id = 1 AND source.version = 2;
      IF v_generation IS NULL THEN
        RAISE EXCEPTION 'INSIGHTS_STORAGE_NOT_READY' USING ERRCODE = 'P0001';
      END IF;
      IF v_source_poison IS NOT NULL THEN
        RETURN jsonb_build_object(
          'state', 'failed', 'jobId', 'supabase-v2-migration',
          'sourceGeneration', v_generation, 'error', 'migration-poison'
        );
      END IF;
      IF NOT v_source_ready THEN
        RETURN jsonb_build_object(
          'state', 'preparing', 'jobId', 'supabase-v2-migration',
          'sourceGeneration', v_generation
        );
      END IF;
      SELECT coalesce((
        SELECT alias.id
        FROM public.hot_updater_v1_insights_aliases AS alias
        ORDER BY alias.id DESC LIMIT 1
      ), 0) INTO v_alias_upper_id;
      v_job_id := 'search:' || encode(sha256(convert_to(
        p_database_namespace::text || ':' || encode(v_query_key, 'hex') || ':' ||
          v_source_id::text || ':' ||
          v_source_seq::text || ':' || v_observed_at_ms::bigint::text || ':' ||
          gen_random_uuid()::text,
        'utf8'
      )), 'hex');
      INSERT INTO public.hot_updater_v1_insights_search_jobs (
        id, query_key, selector, source_id, source_seq, source_generation,
        as_of_ms, alias_upper_id, state
      ) VALUES (
        v_job_id, v_query_key, p_selector, v_source_id, v_source_seq,
        v_generation, v_observed_at_ms, v_alias_upper_id, 'preparing'
      );
      SELECT * INTO v_job
      FROM public.hot_updater_v1_insights_search_jobs AS job
      WHERE job.id = v_job_id FOR UPDATE;
    END IF;
  END IF;

  IF v_job.state = 'failed' THEN
    RETURN jsonb_build_object(
      'state', 'failed', 'jobId', v_job.id,
      'sourceGeneration', v_job.source_generation,
      'error', v_job.error
    );
  END IF;

  IF v_job.state = 'preparing' THEN
    IF v_previous.id IS NULL THEN
      RETURN jsonb_build_object(
        'state', 'preparing', 'jobId', v_job.id,
        'sourceGeneration', v_job.source_generation
      );
    END IF;
    v_refresh_job_id := v_job.id;
    v_job := v_previous;
    v_response_state := 'stale';
  END IF;

  IF v_after IS NOT NULL THEN
    SELECT result.install_key INTO v_result_last
    FROM public.hot_updater_v1_insights_search_results AS result
    WHERE result.job_id=v_job.id AND result.ordinal=v_after_ordinal;
    IF NOT FOUND THEN
      IF v_after_ordinal < 0 OR v_after_ordinal >= v_job.total THEN
        RAISE EXCEPTION 'Invalid installation page cursor'
          USING ERRCODE='22023';
      END IF;
      RAISE EXCEPTION 'INSIGHTS_STORAGE_CORRUPTION' USING ERRCODE='P0001';
    END IF;
    IF v_result_last <> v_after THEN
      RAISE EXCEPTION 'Invalid installation page cursor'
        USING ERRCODE='22023';
    END IF;
  END IF;
  v_result := (
    WITH candidates AS MATERIALIZED (
      SELECT result.*
      FROM public.hot_updater_v1_insights_search_results AS result
      WHERE result.job_id = v_job.id
        AND result.ordinal > v_after_ordinal
      ORDER BY result.ordinal LIMIT p_limit + 1
    ), measured AS (
      SELECT candidate.*,
        sum(octet_length(public.hot_updater_v1_insights_canonical_json(
          public.hot_updater_v1_insights_installation_row(candidate.event)
        )) + 1) OVER (ORDER BY candidate.ordinal) AS cumulative_bytes
      FROM candidates AS candidate
    ), page AS (
      SELECT * FROM measured WHERE cumulative_bytes <= 1039000
      ORDER BY ordinal LIMIT p_limit
    )
    SELECT jsonb_build_object(
      'state', v_response_state,
      'rows', coalesce((SELECT jsonb_agg(
        public.hot_updater_v1_insights_installation_row(page.event)
        ORDER BY page.ordinal
      ) FROM page), '[]'::jsonb),
      'hasMore', v_job.total > v_after_ordinal + 1 +
        (SELECT count(*) FROM page),
      'candidateReads', (SELECT count(*) FROM candidates),
      'lastKey', (SELECT encode(page.install_key, 'hex') FROM page
        ORDER BY page.ordinal DESC LIMIT 1),
      'lastOrdinal', (SELECT page.ordinal::text FROM page
        ORDER BY page.ordinal DESC LIMIT 1),
      'corrupt', (SELECT count(*) FROM candidates) <> least(
        p_limit + 1, greatest(v_job.total - v_after_ordinal - 1, 0)
      ) OR EXISTS (
        SELECT 1 FROM (
          SELECT candidate.ordinal,
            row_number() OVER (ORDER BY candidate.ordinal) AS position
          FROM candidates AS candidate
        ) AS ordered
        WHERE ordered.ordinal <> v_after_ordinal + ordered.position
      ) OR EXISTS (
        SELECT 1 FROM candidates AS candidate
        WHERE candidate.install_key <> sha256(convert_to(
            to_jsonb(candidate.install_id)::text,'utf8'
          ))
          OR candidate.event->>'install_id' <> candidate.install_id
          OR candidate.event->>'id' !~
            '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      ),
      'consistency', 'snapshot',
      'sourceGeneration', v_job.source_generation,
      'total', v_job.total,
      'publication', jsonb_build_object(
        'id', v_job.id,
        'asOfMs', v_job.as_of_ms,
        'completedAtMs', v_job.completed_at_ms
      )
    ) || CASE WHEN v_response_state = 'stale'
      THEN jsonb_build_object('refreshJobId', v_refresh_job_id)
      ELSE '{}'::jsonb END
  );
  IF (v_result->>'corrupt')::boolean THEN
    RAISE EXCEPTION 'INSIGHTS_STORAGE_CORRUPTION' USING ERRCODE='P0001';
  END IF;
  RETURN v_result - 'corrupt';
END;
$$;

REVOKE ALL ON FUNCTION public.hot_updater_v1_insights_installation_page(
  uuid, jsonb, integer, text, text, text, double precision, double precision
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hot_updater_v1_insights_installation_page(
  uuid, jsonb, integer, text, text, text, double precision, double precision
) TO service_role;


CREATE FUNCTION public.hot_updater_v1_insights_search_step(
  p_database_namespace uuid,
  p_job_id text,
  p_max_items integer,
  p_max_bytes integer
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_job public.hot_updater_v1_insights_search_jobs;
  v_kind text;
  v_step_last bigint;
  v_result_last bytea;
  v_step_count integer := 0;
  v_inserted integer := 0;
  v_has_remaining boolean;
  v_lease_owner uuid;
  v_lease_epoch bigint;
  v_processed integer := 0;
  v_bytes bigint := 0;
  v_error_message text;
  v_aliases_valid boolean := true;
BEGIN
  IF p_job_id IS NULL OR length(p_job_id) > 128
    OR p_max_items IS NULL OR p_max_items NOT BETWEEN 1 AND 4096
    OR p_max_bytes IS NULL OR p_max_bytes NOT BETWEEN 1 AND 4194304
  THEN
    RAISE EXCEPTION 'Invalid Insights search step' USING ERRCODE = '22023';
  END IF;
  PERFORM public.hot_updater_v1_insights_bind_namespace(
    p_database_namespace
  );
  IF NOT coalesce(public.hot_updater_v1_insights_layout_ready('search'), false)
  THEN
    RAISE EXCEPTION 'INSIGHTS_STORAGE_NOT_READY' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_job
  FROM public.hot_updater_v1_insights_search_jobs AS job
  WHERE job.id = p_job_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'state', 'failed', 'jobId', p_job_id,
      'processed', 0, 'bytes', 0
    );
  END IF;
  IF v_job.state = 'ready' THEN
    RETURN jsonb_build_object(
      'state', 'complete', 'jobId', v_job.id, 'publicationId', v_job.id,
      'sourceGeneration', v_job.source_generation,
      'processed', 0, 'bytes', 0
    );
  END IF;
  IF v_job.state = 'failed' THEN
    RETURN jsonb_build_object(
      'state', 'failed', 'jobId', v_job.id,
      'sourceGeneration', v_job.source_generation,
      'processed', 0, 'bytes', 0
    );
  END IF;
  v_kind := v_job.selector->>'kind';
  IF v_kind='userId' AND EXISTS (
    SELECT 1 FROM public.hot_updater_v1_insights_aliases AS alias
    WHERE alias.alias_kind='userId'
      AND alias.alias_key=sha256(convert_to(
        to_jsonb(v_job.selector->>'userId')::text,'utf8'
      ))
      AND alias.original_alias<>v_job.selector->>'userId'
    LIMIT 1
  ) THEN
    RAISE EXCEPTION 'INSIGHTS_STORAGE_CORRUPTION' USING ERRCODE='P0001';
  END IF;
  v_lease_owner := gen_random_uuid();
  UPDATE public.hot_updater_v1_insights_search_jobs AS job
  SET lease_epoch = job.lease_epoch + 1,
    lease_owner = v_lease_owner,
    lease_expires_at_ms =
      floor(extract(epoch FROM statement_timestamp()) * 1000) + 300000
  WHERE job.id = v_job.id
    AND job.state = 'preparing'
    AND job.lease_epoch = v_job.lease_epoch
  RETURNING * INTO v_job;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INSIGHTS_SEARCH_LEASE_LOST' USING ERRCODE = 'P0001';
  END IF;
  v_lease_epoch := v_job.lease_epoch;

  BEGIN
    IF v_job.phase = 'aliases' THEN
      WITH bounded AS MATERIALIZED (
        SELECT alias.*,
          sum(octet_length(alias.original_alias) +
            octet_length(alias.normalized_alias) + 160
          ) OVER (ORDER BY alias.id) AS cumulative_bytes
        FROM public.hot_updater_v1_insights_aliases AS alias
        WHERE alias.id > v_job.after_alias_id
          AND alias.id <= v_job.alias_upper_id
          AND alias.source_seq <= v_job.source_seq
          AND (v_kind = 'contains' OR (
            alias.alias_kind = 'userId'
            AND alias.alias_key=sha256(convert_to(
              to_jsonb(v_job.selector->>'userId')::text,'utf8'
            ))
            AND alias.original_alias=v_job.selector->>'userId'
          ))
        ORDER BY alias.id
        LIMIT p_max_items
      ), step AS MATERIALIZED (
        SELECT * FROM bounded WHERE cumulative_bytes <= p_max_bytes
      ), inserted AS (
        INSERT INTO public.hot_updater_v1_insights_search_members (
          job_id, install_key
        )
        SELECT v_job.id, step.install_key FROM step
        WHERE ((v_kind = 'contains' AND strpos(
            step.normalized_alias, v_job.selector->>'query'
          ) > 0) OR v_kind = 'userId')
          AND public.hot_updater_v1_insights_search_lease_current(
            v_job.id, v_lease_owner, v_lease_epoch
          )
        ON CONFLICT DO NOTHING
        RETURNING 1
      )
      SELECT max(step.id), count(*)::integer,
          coalesce(bool_and(step.alias_key=sha256(convert_to(
            to_jsonb(step.original_alias)::text,'utf8'
          ))),true),
          coalesce(max(step.cumulative_bytes), 0)::bigint
        INTO v_step_last, v_processed, v_aliases_valid, v_bytes FROM step;
      IF NOT v_aliases_valid THEN
        RAISE EXCEPTION 'INSIGHTS_STORAGE_CORRUPTION' USING ERRCODE='P0001';
      END IF;

      IF v_step_last IS NOT NULL THEN
        UPDATE public.hot_updater_v1_insights_search_jobs AS job
        SET after_alias_id = v_step_last
        WHERE job.id = v_job.id
          AND public.hot_updater_v1_insights_search_lease_current(
            v_job.id, v_lease_owner, v_lease_epoch
          );
        IF NOT FOUND THEN
          RAISE EXCEPTION 'INSIGHTS_SEARCH_LEASE_LOST' USING ERRCODE = 'P0001';
        END IF;
        v_job.after_alias_id := v_step_last;
      END IF;
      SELECT EXISTS (
        SELECT 1 FROM public.hot_updater_v1_insights_aliases AS alias
        WHERE alias.id > v_job.after_alias_id
          AND alias.id <= v_job.alias_upper_id
          AND alias.source_seq <= v_job.source_seq
          AND (v_kind = 'contains' OR (
            alias.alias_kind = 'userId'
            AND alias.alias_key=sha256(convert_to(
              to_jsonb(v_job.selector->>'userId')::text,'utf8'
            ))
            AND alias.original_alias=v_job.selector->>'userId'
          ))
        LIMIT 1
      ) INTO v_has_remaining;
      IF NOT v_has_remaining THEN
        UPDATE public.hot_updater_v1_insights_search_jobs AS job
        SET phase = 'results'
        WHERE job.id = v_job.id
          AND public.hot_updater_v1_insights_search_lease_current(
            v_job.id, v_lease_owner, v_lease_epoch
          );
        IF NOT FOUND THEN
          RAISE EXCEPTION 'INSIGHTS_SEARCH_LEASE_LOST' USING ERRCODE = 'P0001';
        END IF;
        v_job.phase := 'results';
      END IF;

      UPDATE public.hot_updater_v1_insights_search_jobs AS job
      SET lease_owner = null, lease_expires_at_ms = null
      WHERE job.id = v_job.id
        AND public.hot_updater_v1_insights_search_lease_current(
          v_job.id, v_lease_owner, v_lease_epoch
        );
      IF NOT FOUND THEN
        RAISE EXCEPTION 'INSIGHTS_SEARCH_LEASE_LOST' USING ERRCODE = 'P0001';
      END IF;
      RETURN jsonb_build_object(
        'state', 'running', 'jobId', v_job.id,
        'sourceGeneration', v_job.source_generation,
        'processed', v_processed, 'bytes', v_bytes
      );
    END IF;

    IF v_job.phase = 'results' THEN
      WITH candidates AS MATERIALIZED (
        SELECT member.install_key, latest.install_id,
          public.hot_updater_v1_insights_event_json(latest) AS event,
          coalesce(
            latest.id = projected.event_id
              AND latest.insights_source_seq <= projected.source_seq
              AND latest.insights_install_key = member.install_key
              AND member.install_key = sha256(convert_to(
                to_jsonb(latest.install_id)::text, 'utf8'
              ))
              AND public.hot_updater_v1_insights_event_matches_row(latest),
            false
          ) AS valid
        FROM public.hot_updater_v1_insights_search_members AS member
        LEFT JOIN LATERAL (
          SELECT version.event_id, version.source_seq
          FROM public.hot_updater_v1_insights_installation_versions AS version
          WHERE version.install_key = member.install_key
            AND version.source_seq <= v_job.source_seq
          ORDER BY version.source_seq DESC
          LIMIT 1
        ) AS projected ON true
        LEFT JOIN public.hot_updater_v1_bundle_events AS latest
          ON latest.id = projected.event_id
        WHERE member.job_id = v_job.id
          AND (v_job.result_after_key IS NULL OR
            member.install_key > v_job.result_after_key)
        ORDER BY member.install_key
        LIMIT p_max_items
      ), measured AS (
        SELECT candidate.*,
          sum(coalesce(octet_length(public.hot_updater_v1_insights_canonical_json(
            public.hot_updater_v1_insights_installation_row(candidate.event)
          )), 0) + 160) OVER (
            ORDER BY candidate.install_key
          ) AS cumulative_bytes
        FROM candidates AS candidate
      ), step AS MATERIALIZED (
        SELECT * FROM measured WHERE cumulative_bytes <= p_max_bytes
      ), inserted AS (
        INSERT INTO public.hot_updater_v1_insights_search_results (
          job_id, install_key, ordinal, install_id, event
        )
        SELECT v_job.id, step.install_key,
          v_job.total + row_number() OVER (ORDER BY step.install_key) - 1,
          step.install_id, step.event
        FROM step
        WHERE step.valid
          AND public.hot_updater_v1_insights_search_lease_current(
            v_job.id, v_lease_owner, v_lease_epoch
          )
        RETURNING 1
      )
      SELECT (SELECT step.install_key FROM step
          ORDER BY step.install_key DESC LIMIT 1),
        (SELECT count(*) FROM step), (SELECT count(*) FROM inserted),
        coalesce((SELECT max(step.cumulative_bytes) FROM step), 0)::bigint
      INTO v_result_last, v_step_count, v_inserted, v_bytes;
      v_processed := v_step_count;

      IF v_step_count <> v_inserted THEN
        RAISE EXCEPTION 'INSIGHTS_STORAGE_CORRUPTION' USING ERRCODE = 'P0001';
      END IF;
      IF v_result_last IS NOT NULL THEN
        UPDATE public.hot_updater_v1_insights_search_jobs AS job
        SET result_after_key = v_result_last,
          total = job.total + v_inserted
        WHERE job.id = v_job.id
          AND public.hot_updater_v1_insights_search_lease_current(
            v_job.id, v_lease_owner, v_lease_epoch
          )
        RETURNING * INTO v_job;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'INSIGHTS_SEARCH_LEASE_LOST' USING ERRCODE = 'P0001';
        END IF;
      END IF;
      SELECT EXISTS (
        SELECT 1 FROM public.hot_updater_v1_insights_search_members AS member
        WHERE member.job_id = v_job.id
          AND (v_job.result_after_key IS NULL OR
            member.install_key > v_job.result_after_key)
        LIMIT 1
      ) INTO v_has_remaining;
      IF v_has_remaining THEN
        UPDATE public.hot_updater_v1_insights_search_jobs AS job
        SET lease_owner = null, lease_expires_at_ms = null
        WHERE job.id = v_job.id
          AND public.hot_updater_v1_insights_search_lease_current(
            v_job.id, v_lease_owner, v_lease_epoch
          );
        IF NOT FOUND THEN
          RAISE EXCEPTION 'INSIGHTS_SEARCH_LEASE_LOST' USING ERRCODE = 'P0001';
        END IF;
        RETURN jsonb_build_object(
          'state', 'running', 'jobId', v_job.id,
          'sourceGeneration', v_job.source_generation,
          'processed', v_processed, 'bytes', v_bytes
        );
      ELSE
        UPDATE public.hot_updater_v1_insights_search_jobs AS job
        SET state = 'ready',
          completed_at_ms = floor(extract(epoch FROM clock_timestamp()) * 1000),
          lease_owner = null, lease_expires_at_ms = null
        WHERE job.id = v_job.id
          AND public.hot_updater_v1_insights_search_lease_current(
            v_job.id, v_lease_owner, v_lease_epoch
          )
        RETURNING * INTO v_job;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'INSIGHTS_SEARCH_LEASE_LOST' USING ERRCODE = 'P0001';
        END IF;
      END IF;
    END IF;
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    GET STACKED DIAGNOSTICS v_error_message = MESSAGE_TEXT;
    IF v_error_message <> 'INSIGHTS_STORAGE_CORRUPTION' THEN
      RAISE;
    END IF;
    UPDATE public.hot_updater_v1_insights_search_jobs AS job
    SET state = 'failed', error = 'migration-poison',
      completed_at_ms = floor(extract(epoch FROM clock_timestamp()) * 1000),
      lease_owner = null, lease_expires_at_ms = null
    WHERE job.id = v_job.id
      AND job.lease_owner = v_lease_owner
      AND job.lease_epoch = v_lease_epoch
    RETURNING * INTO v_job;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'INSIGHTS_SEARCH_LEASE_LOST' USING ERRCODE = 'P0001';
    END IF;
    RETURN jsonb_build_object(
      'state', 'failed', 'jobId', v_job.id,
      'sourceGeneration', v_job.source_generation,
      'processed', v_processed, 'bytes', v_bytes
    );
  END;
  IF v_job.state = 'ready' THEN
    RETURN jsonb_build_object(
      'state', 'complete', 'jobId', v_job.id, 'publicationId', v_job.id,
      'sourceGeneration', v_job.source_generation,
      'processed', v_processed, 'bytes', v_bytes
    );
  END IF;
  RETURN jsonb_build_object(
    'state', 'running', 'jobId', v_job.id,
    'sourceGeneration', v_job.source_generation,
    'processed', v_processed, 'bytes', v_bytes
  );
END;
$$;

REVOKE ALL ON FUNCTION public.hot_updater_v1_insights_search_step(
  uuid, text, integer, integer
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hot_updater_v1_insights_search_step(
  uuid, text, integer, integer
) TO service_role;


CREATE TABLE public.hot_updater_v1_insights_report_jobs (
  id text PRIMARY KEY,
  query_key bytea NOT NULL,
  query jsonb NOT NULL,
  source_id uuid NOT NULL,
  source_seq bigint NOT NULL CHECK (source_seq >= 0),
  source_generation text NOT NULL,
  as_of_ms double precision NOT NULL,
  window_start_ms double precision,
  bucket_ms double precision NOT NULL,
  last_bucket_ms double precision NOT NULL,
  phase text NOT NULL DEFAULT 'source'
    CHECK (phase IN ('source', 'latest', 'output', 'publish')),
  after_source_seq bigint NOT NULL DEFAULT 0,
  after_latest_key bytea,
  after_latest_bucket double precision NOT NULL DEFAULT -2,
  output_section integer NOT NULL DEFAULT 0,
  output_after text,
  lease_epoch bigint NOT NULL DEFAULT 0 CHECK (lease_epoch >= 0),
  lease_owner uuid,
  lease_expires_at_ms double precision,
  state text NOT NULL CHECK (state IN ('preparing', 'ready', 'failed')),
  completed_at_ms double precision,
  installed_count bigint NOT NULL DEFAULT 0,
  recovered_count bigint NOT NULL DEFAULT 0,
  tracked_count bigint NOT NULL DEFAULT 0,
  active_count bigint NOT NULL DEFAULT 0,
  summary jsonb NOT NULL DEFAULT '[]'::jsonb,
  error text,
  visible boolean NOT NULL DEFAULT true
);
CREATE INDEX hot_updater_v1_insights_report_jobs_lookup_idx
  ON public.hot_updater_v1_insights_report_jobs(
    query_key, state, as_of_ms DESC, id COLLATE "C" DESC
  );
CREATE UNIQUE INDEX hot_updater_v1_insights_report_jobs_active_idx
  ON public.hot_updater_v1_insights_report_jobs(query_key)
  WHERE state = 'preparing';
CREATE INDEX hot_updater_v1_insights_report_jobs_retention_idx
  ON public.hot_updater_v1_insights_report_jobs(
    state, completed_at_ms, id COLLATE "C"
  );
CREATE INDEX hot_updater_v1_insights_report_jobs_queue_idx
  ON public.hot_updater_v1_insights_report_jobs(id COLLATE "C")
  WHERE state='preparing' AND visible;

CREATE TABLE public.hot_updater_v1_insights_report_members (
  job_id text NOT NULL REFERENCES public.hot_updater_v1_insights_report_jobs(id)
    ON DELETE CASCADE,
  dimension text NOT NULL,
  discriminator text NOT NULL DEFAULT '',
  group_digest bytea NOT NULL CHECK (octet_length(group_digest) = 32),
  group_order bytea NOT NULL CHECK (octet_length(group_order) <= 2048),
  group_key text COLLATE "C" NOT NULL,
  install_key bytea NOT NULL CHECK (octet_length(install_key) = 32),
  PRIMARY KEY (job_id, dimension, discriminator, group_digest, install_key)
);

CREATE TABLE public.hot_updater_v1_insights_report_counts (
  job_id text NOT NULL REFERENCES public.hot_updater_v1_insights_report_jobs(id)
    ON DELETE CASCADE,
  dimension text NOT NULL,
  discriminator text NOT NULL DEFAULT '',
  group_digest bytea NOT NULL CHECK (octet_length(group_digest) = 32),
  group_order bytea NOT NULL CHECK (octet_length(group_order) <= 2048),
  group_key text COLLATE "C" NOT NULL,
  label text,
  label_order bytea,
  bundle_id uuid,
  bucket_start_ms double precision,
  value bigint NOT NULL CHECK (value > 0),
  PRIMARY KEY (job_id, dimension, discriminator, group_digest)
);
CREATE INDEX hot_updater_v1_insights_report_counts_rank_idx
  ON public.hot_updater_v1_insights_report_counts(
    job_id, dimension, discriminator, value DESC, bundle_id
  );
CREATE INDEX hot_updater_v1_insights_report_counts_order_idx
  ON public.hot_updater_v1_insights_report_counts(
    job_id, dimension, discriminator, group_order, group_digest
  );

CREATE TABLE public.hot_updater_v1_insights_report_section_totals (
  job_id text NOT NULL REFERENCES public.hot_updater_v1_insights_report_jobs(id)
    ON DELETE CASCADE,
  dimension text NOT NULL,
  discriminator text NOT NULL DEFAULT '',
  total bigint NOT NULL CHECK (total >= 0),
  PRIMARY KEY (job_id, dimension, discriminator)
);

CREATE TABLE public.hot_updater_v1_insights_report_latest (
  job_id text NOT NULL REFERENCES public.hot_updater_v1_insights_report_jobs(id)
    ON DELETE CASCADE,
  install_key bytea NOT NULL CHECK (octet_length(install_key) = 32),
  bucket_start_ms double precision NOT NULL,
  received_at_ms double precision NOT NULL,
  event_id uuid NOT NULL,
  event jsonb NOT NULL,
  PRIMARY KEY (job_id, install_key, bucket_start_ms)
);

CREATE TABLE public.hot_updater_v1_insights_report_bundle_order (
  job_id text NOT NULL REFERENCES public.hot_updater_v1_insights_report_jobs(id)
    ON DELETE CASCADE,
  order_key text COLLATE "C" NOT NULL,
  bundle_id uuid NOT NULL,
  observations bigint NOT NULL,
  PRIMARY KEY (job_id, order_key),
  CONSTRAINT hot_updater_v1_insights_report_bundle_order_bundle_key
    UNIQUE (job_id, bundle_id)
);

CREATE TABLE public.hot_updater_v1_insights_report_rows (
  publication_id text NOT NULL
    REFERENCES public.hot_updater_v1_insights_publications(id) ON DELETE CASCADE,
  section text NOT NULL,
  discriminator text NOT NULL DEFAULT '',
  bundle_id uuid,
  ordinal bigint NOT NULL CHECK (ordinal >= 0),
  order_key text COLLATE "C" NOT NULL,
  row jsonb NOT NULL,
  PRIMARY KEY (publication_id, section, discriminator, ordinal)
);
CREATE INDEX hot_updater_v1_insights_report_rows_bundle_idx
  ON public.hot_updater_v1_insights_report_rows(
    publication_id, section, discriminator, bundle_id, ordinal
  );
ALTER TABLE public.hot_updater_v1_insights_report_rows ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.hot_updater_v1_insights_report_totals (
  publication_id text NOT NULL
    REFERENCES public.hot_updater_v1_insights_publications(id) ON DELETE CASCADE,
  section text NOT NULL,
  discriminator text NOT NULL DEFAULT '',
  bundle_key text NOT NULL DEFAULT '',
  total bigint NOT NULL CHECK (total >= 0),
  PRIMARY KEY (publication_id, section, discriminator, bundle_key)
);
ALTER TABLE public.hot_updater_v1_insights_report_totals ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.hot_updater_v1_insights_report_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hot_updater_v1_insights_report_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hot_updater_v1_insights_report_counts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hot_updater_v1_insights_report_section_totals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hot_updater_v1_insights_report_latest ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hot_updater_v1_insights_report_bundle_order ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION public.hot_updater_v1_insights_job_next(
  p_database_namespace uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_source public.hot_updater_v1_insights_source_state;
  v_job_id text;
BEGIN
  IF p_database_namespace IS NULL THEN
    RAISE EXCEPTION 'Invalid Insights database namespace'
      USING ERRCODE='22023';
  END IF;
  PERFORM public.hot_updater_v1_insights_bind_namespace(
    p_database_namespace
  );
  IF NOT coalesce(
    public.hot_updater_v1_insights_layout_ready('maintenance'), false
  ) THEN
    RAISE EXCEPTION 'INSIGHTS_STORAGE_NOT_READY' USING ERRCODE='P0001';
  END IF;
  SELECT source.* INTO v_source
  FROM public.hot_updater_v1_insights_source_state AS source
  WHERE source.id=1 AND source.version=2;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INSIGHTS_STORAGE_NOT_READY' USING ERRCODE='P0001';
  END IF;
  IF NOT v_source.ready OR v_source.poison IS NOT NULL THEN
    RETURN jsonb_build_object(
      'state','queued','jobId','supabase-v2-migration'
    );
  END IF;

  SELECT queued.id INTO v_job_id
  FROM (
    (SELECT job.id
     FROM public.hot_updater_v1_insights_search_jobs AS job
     WHERE job.state='preparing' AND job.visible
     ORDER BY job.id COLLATE "C" LIMIT 1)
    UNION ALL
    (SELECT job.id
     FROM public.hot_updater_v1_insights_report_jobs AS job
     WHERE job.state='preparing' AND job.visible
     ORDER BY job.id COLLATE "C" LIMIT 1)
  ) AS queued
  ORDER BY queued.id COLLATE "C" LIMIT 1;
  IF v_job_id IS NULL THEN
    RETURN jsonb_build_object('state','idle');
  END IF;
  RETURN jsonb_build_object('state','queued','jobId',v_job_id);
END;
$$;
REVOKE ALL ON FUNCTION public.hot_updater_v1_insights_job_next(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hot_updater_v1_insights_job_next(uuid)
  TO service_role;

CREATE FUNCTION public.hot_updater_v1_insights_report_add_member(
  p_job_id text, p_dimension text, p_discriminator text, p_group_key text,
  p_label text, p_label_order bytea, p_bundle_id uuid,
  p_bucket_start_ms double precision, p_install_key bytea
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_group_digest bytea:=sha256(convert_to(to_jsonb(p_group_key)::text,'utf8'));
  v_group_order bytea:=coalesce(
    p_label_order,public.hot_updater_v1_insights_js_order(p_group_key)
  );
  v_existing_member public.hot_updater_v1_insights_report_members;
  v_existing_count public.hot_updater_v1_insights_report_counts;
BEGIN
  SELECT member.* INTO v_existing_member
  FROM public.hot_updater_v1_insights_report_members AS member
  WHERE member.job_id=p_job_id AND member.dimension=p_dimension
    AND member.discriminator=p_discriminator
    AND member.group_digest=v_group_digest
    AND member.install_key=p_install_key;
  IF FOUND AND (v_existing_member.group_key<>p_group_key
    OR v_existing_member.group_order<>v_group_order)
  THEN
    RAISE EXCEPTION 'INSIGHTS_STORAGE_CORRUPTION' USING ERRCODE='P0001';
  END IF;
  SELECT counter.* INTO v_existing_count
  FROM public.hot_updater_v1_insights_report_counts AS counter
  WHERE counter.job_id=p_job_id AND counter.dimension=p_dimension
    AND counter.discriminator=p_discriminator
    AND counter.group_digest=v_group_digest;
  IF FOUND AND (v_existing_count.group_key<>p_group_key
    OR v_existing_count.group_order<>v_group_order
    OR v_existing_count.label IS DISTINCT FROM p_label
    OR v_existing_count.label_order IS DISTINCT FROM p_label_order
    OR v_existing_count.bundle_id IS DISTINCT FROM p_bundle_id
    OR v_existing_count.bucket_start_ms IS DISTINCT FROM p_bucket_start_ms)
  THEN
    RAISE EXCEPTION 'INSIGHTS_STORAGE_CORRUPTION' USING ERRCODE='P0001';
  END IF;
  IF v_existing_member.job_id IS NOT NULL THEN
    IF v_existing_count.job_id IS NULL THEN
      RAISE EXCEPTION 'INSIGHTS_STORAGE_CORRUPTION' USING ERRCODE='P0001';
    END IF;
    RETURN false;
  END IF;
  INSERT INTO public.hot_updater_v1_insights_report_members (
    job_id, dimension, discriminator, group_digest, group_order, group_key,
    install_key
  ) VALUES (
    p_job_id, p_dimension, p_discriminator, v_group_digest, v_group_order,
    p_group_key, p_install_key
  ) ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN
    SELECT member.* INTO v_existing_member
    FROM public.hot_updater_v1_insights_report_members AS member
    WHERE member.job_id=p_job_id AND member.dimension=p_dimension
      AND member.discriminator=p_discriminator
      AND member.group_digest=v_group_digest
      AND member.install_key=p_install_key;
    IF NOT FOUND OR v_existing_member.group_key<>p_group_key
      OR v_existing_member.group_order<>v_group_order
    THEN
      RAISE EXCEPTION 'INSIGHTS_STORAGE_CORRUPTION' USING ERRCODE='P0001';
    END IF;
    RETURN false;
  END IF;
  INSERT INTO public.hot_updater_v1_insights_report_counts (
    job_id, dimension, discriminator, group_digest, group_order, group_key,
    label, label_order,
    bundle_id, bucket_start_ms, value
  ) VALUES (
    p_job_id, p_dimension, p_discriminator, v_group_digest, v_group_order,
    p_group_key, p_label, p_label_order, p_bundle_id, p_bucket_start_ms, 1
  ) ON CONFLICT DO NOTHING;
  IF FOUND THEN
    INSERT INTO public.hot_updater_v1_insights_report_section_totals (
      job_id, dimension, discriminator, total
    ) VALUES (p_job_id, p_dimension, p_discriminator, 1)
    ON CONFLICT (job_id, dimension, discriminator)
    DO UPDATE SET total =
      public.hot_updater_v1_insights_report_section_totals.total + 1;
  ELSE
    SELECT counter.* INTO v_existing_count
    FROM public.hot_updater_v1_insights_report_counts AS counter
    WHERE counter.job_id=p_job_id AND counter.dimension=p_dimension
      AND counter.discriminator=p_discriminator
      AND counter.group_digest=v_group_digest;
    IF NOT FOUND OR v_existing_count.group_key<>p_group_key
      OR v_existing_count.group_order<>v_group_order
      OR v_existing_count.label IS DISTINCT FROM p_label
      OR v_existing_count.label_order IS DISTINCT FROM p_label_order
      OR v_existing_count.bundle_id IS DISTINCT FROM p_bundle_id
      OR v_existing_count.bucket_start_ms IS DISTINCT FROM p_bucket_start_ms
    THEN
      RAISE EXCEPTION 'INSIGHTS_STORAGE_CORRUPTION' USING ERRCODE='P0001';
    END IF;
    UPDATE public.hot_updater_v1_insights_report_counts AS counter
    SET value = counter.value + 1
    WHERE counter.job_id = p_job_id
      AND counter.dimension = p_dimension
      AND counter.discriminator = p_discriminator
      AND counter.group_digest=v_group_digest
      AND counter.group_key = p_group_key;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'INSIGHTS_STORAGE_CORRUPTION' USING ERRCODE='P0001';
    END IF;
  END IF;
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.hot_updater_v1_insights_report_add_member(
  text, text, text, text, text, bytea, uuid, double precision, bytea
) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.hot_updater_v1_insights_publication_json(
  p_publication public.hot_updater_v1_insights_publications
) RETURNS jsonb
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog
AS $$
  SELECT jsonb_build_object(
    'id', p_publication.id,
    'asOfMs', p_publication.as_of_ms,
    'completedAtMs', p_publication.completed_at_ms,
    'sourceGeneration', p_publication.source_generation,
    'accuracy', 'exact',
    'kind', p_publication.kind,
    'summary', p_publication.summary
  )
$$;
REVOKE ALL ON FUNCTION public.hot_updater_v1_insights_publication_json(
  public.hot_updater_v1_insights_publications
) FROM PUBLIC, anon, authenticated, service_role;
CREATE FUNCTION public.hot_updater_v1_insights_report(
  p_database_namespace uuid,
  p_query jsonb,
  p_min_as_of_ms double precision DEFAULT NULL,
  p_now_ms double precision DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_kind text := p_query->>'kind';
  v_window text := p_query->>'window';
  v_source_id uuid;
  v_source_seq bigint;
  v_generation text;
  v_as_of_ms double precision := coalesce(p_now_ms,
    floor(extract(epoch FROM clock_timestamp()) * 1000)::double precision);
  v_query_key bytea;
  v_job_id text;
  v_start_ms double precision;
  v_bucket_ms double precision;
  v_last_bucket_ms double precision;
  v_publication public.hot_updater_v1_insights_publications;
  v_previous public.hot_updater_v1_insights_publications;
  v_job public.hot_updater_v1_insights_report_jobs;
  v_source_ready boolean;
  v_source_poison text;
BEGIN
  IF jsonb_typeof(p_query) <> 'object'
    OR v_kind NOT IN (
      'bundleSummaries', 'bundleDetail', 'installationOverview', 'activeOverview'
    )
    OR v_as_of_ms < 0 OR v_as_of_ms > 9007199254740991
    OR v_as_of_ms <> trunc(v_as_of_ms)
    OR (p_min_as_of_ms IS NOT NULL AND (
      p_min_as_of_ms < 0 OR p_min_as_of_ms > 9007199254740991 OR
      p_min_as_of_ms <> trunc(p_min_as_of_ms)
    ))
    OR (v_kind IN ('bundleSummaries', 'bundleDetail')
      AND v_window NOT IN ('24h', '7d', '30d', 'all'))
    OR (v_kind = 'activeOverview' AND v_window NOT IN ('24h', '7d', '30d'))
  THEN
    RAISE EXCEPTION 'Invalid Insights report query' USING ERRCODE = '22023';
  END IF;
  PERFORM public.hot_updater_v1_insights_bind_namespace(
    p_database_namespace
  );
  IF v_kind = 'bundleSummaries' AND (
    jsonb_typeof(p_query->'bundleIds') <> 'array' OR
    jsonb_array_length(p_query->'bundleIds') > 100 OR
    EXISTS (SELECT 1 FROM jsonb_array_elements_text(p_query->'bundleIds') id
      WHERE id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
  ) THEN
    RAISE EXCEPTION 'Invalid bundle summary query' USING ERRCODE = '22023';
  END IF;
  IF v_kind = 'bundleDetail' AND coalesce(p_query->>'bundleId', '') !~
    '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  THEN
    RAISE EXCEPTION 'Invalid bundle detail query' USING ERRCODE = '22023';
  END IF;
  IF NOT coalesce(public.hot_updater_v1_insights_layout_ready('report'), false)
  THEN
    RAISE EXCEPTION 'INSIGHTS_STORAGE_NOT_READY' USING ERRCODE = 'P0001';
  END IF;

  v_query_key := sha256(convert_to(
    'supabase-report-semantics-v3:' || p_query::text, 'utf8'
  ));
  PERFORM pg_advisory_xact_lock(hashtextextended(encode(v_query_key, 'hex'), 0));
  SELECT * INTO v_publication
  FROM public.hot_updater_v1_insights_publications AS publication
  WHERE publication.query_key = v_query_key AND publication.visible
    AND (p_min_as_of_ms IS NULL OR publication.as_of_ms >= p_min_as_of_ms)
  ORDER BY publication.as_of_ms DESC, publication.source_seq DESC,
    publication.id COLLATE "C" DESC LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'state', 'ready',
      'publication', public.hot_updater_v1_insights_publication_json(v_publication)
    );
  END IF;
  SELECT * INTO v_previous
  FROM public.hot_updater_v1_insights_publications AS publication
  WHERE publication.query_key = v_query_key AND publication.visible
  ORDER BY publication.as_of_ms DESC, publication.source_seq DESC,
    publication.id COLLATE "C" DESC LIMIT 1;

  SELECT * INTO v_job
  FROM public.hot_updater_v1_insights_report_jobs AS job
  WHERE job.query_key = v_query_key
    AND job.state IN ('preparing', 'failed') AND job.visible
  ORDER BY job.as_of_ms DESC, job.id COLLATE "C" DESC LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN
    SELECT source.source_id, source.committed_seq,
      jsonb_build_array(
        2, source.database_namespace, source.source_id, source.committed_seq
      )::text,
      source.ready, source.poison
    INTO v_source_id, v_source_seq, v_generation,
      v_source_ready, v_source_poison
    FROM public.hot_updater_v1_insights_source_state AS source
    WHERE source.id = 1 AND source.version = 2;
    IF v_generation IS NULL THEN
      RAISE EXCEPTION 'INSIGHTS_STORAGE_NOT_READY' USING ERRCODE = 'P0001';
    END IF;
    IF v_source_poison IS NOT NULL THEN
      RETURN jsonb_build_object(
        'state', 'failed', 'jobId', 'supabase-v2-migration',
        'sourceGeneration', v_generation, 'error', 'migration-poison'
      );
    END IF;
    IF NOT v_source_ready THEN
      RETURN jsonb_build_object(
        'state', 'preparing', 'jobId', 'supabase-v2-migration',
        'sourceGeneration', v_generation
      );
    END IF;
    IF v_window = '24h' THEN
      v_bucket_ms := 3600000;
      v_start_ms := CASE WHEN v_kind = 'activeOverview'
        THEN v_as_of_ms - 24 * v_bucket_ms
        ELSE floor(v_as_of_ms / v_bucket_ms) * v_bucket_ms - 23 * v_bucket_ms END;
    ELSIF v_window IN ('7d', '30d') THEN
      v_bucket_ms := 86400000;
      v_start_ms := CASE WHEN v_kind = 'activeOverview'
        THEN v_as_of_ms - (CASE v_window WHEN '7d' THEN 7 ELSE 30 END) * v_bucket_ms
        ELSE floor(v_as_of_ms / v_bucket_ms) * v_bucket_ms -
          (CASE v_window WHEN '7d' THEN 6 ELSE 29 END) * v_bucket_ms END;
    ELSE
      v_bucket_ms := 86400000;
      v_start_ms := NULL;
    END IF;
    v_last_bucket_ms := CASE WHEN v_kind = 'activeOverview'
      THEN v_as_of_ms - v_bucket_ms
      ELSE floor(v_as_of_ms / v_bucket_ms) * v_bucket_ms END;
    v_job_id := 'report:' || encode(sha256(convert_to(
      p_database_namespace::text || ':' || encode(v_query_key, 'hex') || ':' ||
        v_source_id::text || ':' ||
        v_source_seq::text || ':' || v_as_of_ms::bigint::text || ':' ||
        gen_random_uuid()::text,
      'utf8'
    )), 'hex');
    INSERT INTO public.hot_updater_v1_insights_report_jobs (
      id, query_key, query, source_id, source_seq, source_generation,
      as_of_ms, window_start_ms, bucket_ms, last_bucket_ms, state
    ) VALUES (
      v_job_id, v_query_key, p_query, v_source_id, v_source_seq, v_generation,
      v_as_of_ms, v_start_ms, v_bucket_ms, v_last_bucket_ms, 'preparing'
    );
    INSERT INTO public.hot_updater_v1_insights_publications (
      id, query, query_key, source_id, source_seq, source_generation,
      as_of_ms, completed_at_ms, visible, kind, summary
    ) VALUES (
      v_job_id, p_query, v_query_key, v_source_id, v_source_seq, v_generation,
      v_as_of_ms, v_as_of_ms, false, v_kind,
      CASE v_kind
        WHEN 'bundleSummaries' THEN '[]'::jsonb
        WHEN 'bundleDetail' THEN '{"installed":0,"recovered":0}'::jsonb
        WHEN 'installationOverview' THEN '{"trackedInstallations":0}'::jsonb
        ELSE '{"activeInstallations":0}'::jsonb END
    );
    SELECT * INTO v_job
    FROM public.hot_updater_v1_insights_report_jobs AS job
    WHERE job.id = v_job_id FOR UPDATE;
  END IF;

  IF v_job.state = 'failed' THEN
    RETURN jsonb_build_object(
      'state', 'failed', 'jobId', v_job.id,
      'sourceGeneration', v_job.source_generation,
      'error', v_job.error
    );
  END IF;
  IF v_previous.id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'state', 'stale', 'refreshJobId', v_job.id,
      'publication', public.hot_updater_v1_insights_publication_json(v_previous)
    );
  END IF;
  RETURN jsonb_build_object(
    'state', 'preparing', 'jobId', v_job.id,
    'sourceGeneration', v_job.source_generation
  );
END;
$$;
REVOKE ALL ON FUNCTION public.hot_updater_v1_insights_report(
  uuid, jsonb, double precision, double precision
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hot_updater_v1_insights_report(
  uuid, jsonb, double precision, double precision
) TO service_role;
CREATE FUNCTION public.hot_updater_v1_insights_report_step(
  p_database_namespace uuid,
  p_job_id text,
  p_max_items integer,
  p_max_bytes integer
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_job public.hot_updater_v1_insights_report_jobs;
  v_row record;
  v_kind text;
  v_metric text;
  v_bundle_id uuid;
  v_bucket double precision;
  v_group text;
  v_last_seq bigint;
  v_processed integer := 0;
  v_bytes bigint := 0;
  v_item_bytes integer;
  v_has_remaining boolean;
  v_added boolean;
  v_lease_owner uuid;
  v_lease_epoch bigint;
  v_selected_user text;
  v_summary jsonb;
  v_total bigint;
  v_start double precision;
  v_next double precision;
  v_end double precision;
  v_output_row jsonb;
  v_output_key text;
  v_ordinal bigint;
  v_next_section integer;
  v_bundle_order public.hot_updater_v1_insights_report_bundle_order;
  v_error_message text;
BEGIN
  IF p_job_id IS NULL OR length(p_job_id) > 128
    OR p_max_items IS NULL OR p_max_items NOT BETWEEN 1 AND 4096
    OR p_max_bytes IS NULL OR p_max_bytes NOT BETWEEN 1 AND 4194304
  THEN
    RAISE EXCEPTION 'Invalid Insights report step' USING ERRCODE = '22023';
  END IF;
  PERFORM public.hot_updater_v1_insights_bind_namespace(
    p_database_namespace
  );
  IF NOT coalesce(public.hot_updater_v1_insights_layout_ready('report'), false)
  THEN
    RAISE EXCEPTION 'INSIGHTS_STORAGE_NOT_READY' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_job FROM public.hot_updater_v1_insights_report_jobs AS job
  WHERE job.id = p_job_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('state','failed','jobId',p_job_id,
      'processed',0,'bytes',0);
  END IF;
  IF v_job.state = 'ready' THEN
    RETURN jsonb_build_object('state','complete','jobId',v_job.id,
      'publicationId',v_job.id,'sourceGeneration',v_job.source_generation,
      'processed',0,'bytes',0);
  END IF;
  IF v_job.state = 'failed' THEN
    RETURN jsonb_build_object('state','failed','jobId',v_job.id,
      'sourceGeneration',v_job.source_generation,'processed',0,'bytes',0);
  END IF;
  v_kind := v_job.query->>'kind';
  v_lease_owner := gen_random_uuid();
  UPDATE public.hot_updater_v1_insights_report_jobs AS job
  SET lease_epoch = job.lease_epoch + 1, lease_owner = v_lease_owner,
    lease_expires_at_ms =
      floor(extract(epoch FROM statement_timestamp()) * 1000) + 300000
  WHERE job.id = v_job.id AND job.state = 'preparing'
    AND job.lease_epoch = v_job.lease_epoch
  RETURNING * INTO v_job;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INSIGHTS_REPORT_LEASE_LOST' USING ERRCODE = 'P0001';
  END IF;
  v_lease_epoch := v_job.lease_epoch;

  BEGIN
    IF v_job.phase = 'source' THEN
      FOR v_row IN
        WITH candidates AS MATERIALIZED (
          SELECT event.insights_source_seq AS source_seq,
            event.insights_install_key AS install_key,
            event.insights_cohort_order AS cohort_order,
            event.id AS event_id, event.type, event.install_id, event.user_id,
            event.from_bundle_id, event.to_bundle_id, event.cohort,
            event.received_at_ms,
            public.hot_updater_v1_insights_event_json(event) AS event_json,
            public.hot_updater_v1_insights_event_matches_row(event)
              AS event_valid,
            coalesce(event.insights_event_bytes, 20481) + 192 AS item_bytes
          FROM public.hot_updater_v1_bundle_events AS event
          WHERE event.insights_source_seq > v_job.after_source_seq
            AND event.insights_source_seq <= v_job.source_seq
          ORDER BY event.insights_source_seq LIMIT p_max_items
        ), measured AS (
          SELECT candidate.*,
            sum(candidate.item_bytes) OVER (ORDER BY candidate.source_seq)
              AS cumulative_bytes
          FROM candidates AS candidate
        )
        SELECT * FROM measured WHERE cumulative_bytes <= p_max_bytes
        ORDER BY source_seq
      LOOP
        v_processed := v_processed + 1;
        v_bytes := v_row.cumulative_bytes;
        v_last_seq := v_row.source_seq;
        IF NOT v_row.event_valid
          OR v_row.install_key IS NULL
          OR octet_length(v_row.install_key) <> 32
          OR v_row.install_key <> sha256(convert_to(
            to_jsonb(v_row.install_id)::text, 'utf8'
          ))
          OR v_row.event_id::text !~
            '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          OR v_row.event_json->>'id' <> v_row.event_id::text
          OR v_row.event_json->>'install_id' <> v_row.install_id
          OR v_row.event_json->>'type' <> v_row.type
          OR v_row.cohort_order IS NULL
          OR v_row.cohort_order <>
            public.hot_updater_v1_insights_js_order(v_row.cohort)
        THEN
          RAISE EXCEPTION 'INSIGHTS_STORAGE_CORRUPTION' USING ERRCODE='P0001';
        END IF;
        IF v_row.received_at_ms >= v_job.as_of_ms THEN CONTINUE; END IF;
        IF v_kind IN ('bundleSummaries','bundleDetail') THEN
          IF v_job.window_start_ms IS NOT NULL
            AND v_row.received_at_ms < v_job.window_start_ms
          THEN CONTINUE; END IF;
          IF v_row.type = 'UPDATE_APPLIED' THEN
            v_metric := 'installed'; v_bundle_id := v_row.to_bundle_id;
          ELSIF v_row.type = 'RECOVERED' THEN
            v_metric := 'recovered'; v_bundle_id := v_row.from_bundle_id;
          ELSE CONTINUE;
          END IF;
          IF (v_kind = 'bundleDetail' AND
                v_bundle_id::text <> v_job.query->>'bundleId')
            OR (v_kind = 'bundleSummaries' AND NOT EXISTS (
              SELECT 1 FROM jsonb_array_elements_text(v_job.query->'bundleIds') id
              WHERE id = v_bundle_id::text
            ))
          THEN CONTINUE; END IF;
          SELECT public.hot_updater_v1_insights_report_add_member(
            v_job.id,'summary',v_metric,v_bundle_id::text,v_bundle_id::text,
            public.hot_updater_v1_insights_js_order(v_bundle_id::text),
            v_bundle_id,null,v_row.install_key
          ) INTO v_added;
          IF v_added AND v_kind = 'bundleDetail' THEN
            IF v_metric = 'installed' THEN
              UPDATE public.hot_updater_v1_insights_report_jobs
              SET installed_count = installed_count + 1 WHERE id = v_job.id;
            ELSE
              UPDATE public.hot_updater_v1_insights_report_jobs
              SET recovered_count = recovered_count + 1 WHERE id = v_job.id;
            END IF;
          END IF;
          IF v_kind = 'bundleDetail' THEN
            v_bucket := floor(v_row.received_at_ms / v_job.bucket_ms) *
              v_job.bucket_ms;
            v_group := lpad(v_bucket::bigint::text,16,'0');
            PERFORM public.hot_updater_v1_insights_report_add_member(
              v_job.id,'movementSeries',v_metric,v_group,null,null,null,
              v_bucket,v_row.install_key
            );
            v_group := v_row.cohort;
            PERFORM public.hot_updater_v1_insights_report_add_member(
              v_job.id,'movementCohorts',v_metric,v_group,v_row.cohort,
              v_row.cohort_order,null,null,v_row.install_key
            );
          END IF;
        ELSIF v_kind = 'installationOverview' THEN
          INSERT INTO public.hot_updater_v1_insights_report_latest (
            job_id,install_key,bucket_start_ms,received_at_ms,event_id,event
          ) VALUES (
            v_job.id,v_row.install_key,-1,v_row.received_at_ms,
            v_row.event_id,v_row.event_json
          ) ON CONFLICT (job_id,install_key,bucket_start_ms) DO UPDATE SET
            received_at_ms=EXCLUDED.received_at_ms,event_id=EXCLUDED.event_id,
            event=EXCLUDED.event
          WHERE (
            public.hot_updater_v1_insights_report_latest.received_at_ms,
            public.hot_updater_v1_insights_report_latest.event_id
          ) < (EXCLUDED.received_at_ms,EXCLUDED.event_id);
        ELSE
          IF v_row.received_at_ms < v_job.window_start_ms THEN CONTINUE; END IF;
          v_bucket := v_job.window_start_ms + floor(
            (v_row.received_at_ms-v_job.window_start_ms)/v_job.bucket_ms
          )*v_job.bucket_ms;
          INSERT INTO public.hot_updater_v1_insights_report_latest (
            job_id,install_key,bucket_start_ms,received_at_ms,event_id,event
          ) VALUES
            (v_job.id,v_row.install_key,-1,v_row.received_at_ms,
              v_row.event_id,v_row.event_json),
            (v_job.id,v_row.install_key,v_bucket,v_row.received_at_ms,
              v_row.event_id,v_row.event_json)
          ON CONFLICT (job_id,install_key,bucket_start_ms) DO UPDATE SET
            received_at_ms=EXCLUDED.received_at_ms,event_id=EXCLUDED.event_id,
            event=EXCLUDED.event
          WHERE (
            public.hot_updater_v1_insights_report_latest.received_at_ms,
            public.hot_updater_v1_insights_report_latest.event_id
          ) < (EXCLUDED.received_at_ms,EXCLUDED.event_id);
        END IF;
      END LOOP;
      IF v_last_seq IS NOT NULL THEN
        UPDATE public.hot_updater_v1_insights_report_jobs
        SET after_source_seq=v_last_seq WHERE id=v_job.id;
        v_job.after_source_seq := v_last_seq;
      END IF;
      SELECT EXISTS (
        SELECT 1 FROM public.hot_updater_v1_bundle_events AS event
        WHERE event.insights_source_seq > v_job.after_source_seq
          AND event.insights_source_seq <= v_job.source_seq LIMIT 1
      ) INTO v_has_remaining;
      IF NOT v_has_remaining THEN
        UPDATE public.hot_updater_v1_insights_report_jobs
        SET phase=CASE WHEN v_kind IN ('installationOverview','activeOverview')
          THEN 'latest' ELSE 'output' END
        WHERE id=v_job.id;
      END IF;
      UPDATE public.hot_updater_v1_insights_report_jobs
      SET lease_owner=null,lease_expires_at_ms=null WHERE id=v_job.id;
      RETURN jsonb_build_object('state','running','jobId',v_job.id,
        'sourceGeneration',v_job.source_generation,'processed',v_processed,
        'bytes',v_bytes);
    END IF;

    IF v_job.phase = 'latest' THEN
      FOR v_row IN
        WITH candidates AS MATERIALIZED (
          SELECT latest.*,
            octet_length(public.hot_updater_v1_insights_canonical_json(
              latest.event
            )) + 192 AS item_bytes
          FROM public.hot_updater_v1_insights_report_latest AS latest
          WHERE latest.job_id=v_job.id AND (
            v_job.after_latest_key IS NULL OR
            (latest.install_key,latest.bucket_start_ms) >
              (v_job.after_latest_key,v_job.after_latest_bucket)
          ) ORDER BY latest.install_key,latest.bucket_start_ms LIMIT p_max_items
        ), measured AS (
          SELECT candidate.*,
            sum(candidate.item_bytes) OVER (
              ORDER BY candidate.install_key,candidate.bucket_start_ms
            ) AS cumulative_bytes
          FROM candidates AS candidate
        )
        SELECT * FROM measured WHERE cumulative_bytes <= p_max_bytes
        ORDER BY install_key,bucket_start_ms
      LOOP
        v_processed:=v_processed+1; v_bytes:=v_row.cumulative_bytes;
        v_job.after_latest_key:=v_row.install_key;
        v_job.after_latest_bucket:=v_row.bucket_start_ms;
        IF v_kind='installationOverview' THEN
          UPDATE public.hot_updater_v1_insights_report_jobs
          SET tracked_count=tracked_count+1 WHERE id=v_job.id;
          PERFORM public.hot_updater_v1_insights_report_add_member(
            v_job.id,'bundleDistribution','',v_row.event->>'to_bundle_id',
            v_row.event->>'to_bundle_id',
            public.hot_updater_v1_insights_js_order(v_row.event->>'to_bundle_id'),
            (v_row.event->>'to_bundle_id')::uuid,null,v_row.install_key
          );
        ELSE
          SELECT selected.event->>'user_id' INTO v_selected_user
          FROM public.hot_updater_v1_insights_report_latest AS selected
          WHERE selected.job_id=v_job.id AND selected.install_key=v_row.install_key
            AND selected.bucket_start_ms=-1;
          IF v_job.query ? 'userId'
            AND v_selected_user IS DISTINCT FROM v_job.query->>'userId'
          THEN CONTINUE; END IF;
          IF v_row.bucket_start_ms=-1 THEN
            UPDATE public.hot_updater_v1_insights_report_jobs
            SET active_count=active_count+1 WHERE id=v_job.id;
            PERFORM public.hot_updater_v1_insights_report_add_member(
              v_job.id,'bundleDistribution','',v_row.event->>'to_bundle_id',
              v_row.event->>'to_bundle_id',
              public.hot_updater_v1_insights_js_order(v_row.event->>'to_bundle_id'),
              (v_row.event->>'to_bundle_id')::uuid,null,v_row.install_key
            );
          ELSE
            v_group:=lpad(v_row.bucket_start_ms::bigint::text,16,'0');
            PERFORM public.hot_updater_v1_insights_report_add_member(
              v_job.id,'activeSeries','',v_group,null,null,null,
              v_row.bucket_start_ms,v_row.install_key
            );
            PERFORM public.hot_updater_v1_insights_report_add_member(
              v_job.id,'activeBundleSeries','',
              (v_row.event->>'to_bundle_id')||':'||v_group,
              v_row.event->>'to_bundle_id',null,
              (v_row.event->>'to_bundle_id')::uuid,v_row.bucket_start_ms,
              v_row.install_key
            );
            PERFORM public.hot_updater_v1_insights_report_add_member(
              v_job.id,'activeBundleRank','',v_row.event->>'to_bundle_id',
              v_row.event->>'to_bundle_id',
              public.hot_updater_v1_insights_js_order(v_row.event->>'to_bundle_id'),
              (v_row.event->>'to_bundle_id')::uuid,null,sha256(
                v_row.install_key || convert_to(
                  v_row.bucket_start_ms::bigint::text,'utf8'
                )
              )
            );
          END IF;
        END IF;
      END LOOP;
      IF v_job.after_latest_key IS NOT NULL THEN
        UPDATE public.hot_updater_v1_insights_report_jobs SET
          after_latest_key=v_job.after_latest_key,
          after_latest_bucket=v_job.after_latest_bucket WHERE id=v_job.id;
      END IF;
      SELECT EXISTS (
        SELECT 1 FROM public.hot_updater_v1_insights_report_latest AS latest
        WHERE latest.job_id=v_job.id AND (
          v_job.after_latest_key IS NULL OR
          (latest.install_key,latest.bucket_start_ms) >
            (v_job.after_latest_key,v_job.after_latest_bucket)
        ) LIMIT 1
      ) INTO v_has_remaining;
      IF NOT v_has_remaining THEN
        UPDATE public.hot_updater_v1_insights_report_jobs SET phase='output'
        WHERE id=v_job.id;
      END IF;
      UPDATE public.hot_updater_v1_insights_report_jobs
      SET lease_owner=null,lease_expires_at_ms=null WHERE id=v_job.id;
      RETURN jsonb_build_object('state','running','jobId',v_job.id,
        'sourceGeneration',v_job.source_generation,'processed',v_processed,
        'bytes',v_bytes);
    END IF;
    IF v_job.phase = 'output' THEN
      IF v_kind='bundleSummaries' THEN
        FOR v_row IN
          SELECT id AS bundle_id FROM jsonb_array_elements_text(
            v_job.query->'bundleIds'
          ) id
          WHERE v_job.output_after IS NULL OR id COLLATE "C" >
            v_job.output_after COLLATE "C"
          ORDER BY id COLLATE "C" LIMIT p_max_items
        LOOP
          SELECT coalesce(max(value),0) INTO v_total
          FROM public.hot_updater_v1_insights_report_counts
          WHERE job_id=v_job.id AND dimension='summary'
            AND discriminator='installed'
            AND group_digest=sha256(convert_to(
              to_jsonb(v_row.bundle_id)::text,'utf8'
            )) AND group_key=v_row.bundle_id;
          SELECT jsonb_build_object('bundleId',v_row.bundle_id,
            'installed',v_total,'recovered',coalesce(max(value),0))
          INTO v_output_row
          FROM public.hot_updater_v1_insights_report_counts
          WHERE job_id=v_job.id AND dimension='summary'
            AND discriminator='recovered'
            AND group_digest=sha256(convert_to(
              to_jsonb(v_row.bundle_id)::text,'utf8'
            )) AND group_key=v_row.bundle_id;
          v_item_bytes:=octet_length(
            public.hot_updater_v1_insights_canonical_json(v_output_row)
          )+64;
          IF v_bytes+v_item_bytes>p_max_bytes THEN EXIT; END IF;
          v_bytes:=v_bytes+v_item_bytes; v_processed:=v_processed+1;
          v_job.summary:=v_job.summary||jsonb_build_array(v_output_row);
          v_job.output_after:=v_row.bundle_id;
        END LOOP;
        UPDATE public.hot_updater_v1_insights_report_jobs SET
          summary=v_job.summary,output_after=v_job.output_after WHERE id=v_job.id;
        SELECT EXISTS (SELECT 1 FROM jsonb_array_elements_text(
          v_job.query->'bundleIds'
        ) id WHERE v_job.output_after IS NULL OR id COLLATE "C" >
          v_job.output_after COLLATE "C" LIMIT 1) INTO v_has_remaining;
        IF NOT v_has_remaining THEN
          UPDATE public.hot_updater_v1_insights_report_jobs
          SET phase='publish',output_after=null WHERE id=v_job.id;
        END IF;
      ELSIF v_kind='bundleDetail' AND v_job.output_section IN (0,1) THEN
        v_metric:=CASE v_job.output_section WHEN 0 THEN 'installed'
          ELSE 'recovered' END;
        SELECT coalesce(v_job.window_start_ms,min(bucket_start_ms),
          v_job.last_bucket_ms) INTO v_start
        FROM public.hot_updater_v1_insights_report_counts
        WHERE job_id=v_job.id AND dimension='movementSeries'
          AND discriminator=v_metric;
        v_next:=CASE WHEN v_job.output_after IS NULL THEN v_start
          ELSE v_job.output_after::double precision+v_job.bucket_ms END;
        v_end:=v_job.last_bucket_ms;
        WHILE v_next<=v_end AND v_processed<p_max_items LOOP
          SELECT coalesce(value,0) INTO v_total
          FROM public.hot_updater_v1_insights_report_counts
          WHERE job_id=v_job.id AND dimension='movementSeries'
            AND discriminator=v_metric
            AND group_digest=sha256(convert_to(to_jsonb(
              lpad(v_next::bigint::text,16,'0')
            )::text,'utf8'))
            AND group_key=lpad(v_next::bigint::text,16,'0');
          v_total:=coalesce(v_total,0);
          v_output_row:=jsonb_build_object('bucketStartMs',v_next,'value',v_total);
          v_item_bytes:=octet_length(
            public.hot_updater_v1_insights_canonical_json(v_output_row)
          )+96;
          IF v_bytes+v_item_bytes>p_max_bytes THEN EXIT; END IF;
          v_output_key:=lpad(v_next::bigint::text,16,'0');
          SELECT coalesce((SELECT report.ordinal+1
            FROM public.hot_updater_v1_insights_report_rows AS report
            WHERE report.publication_id=v_job.id
              AND report.section='movementSeries'
              AND report.discriminator=v_metric
            ORDER BY report.ordinal DESC LIMIT 1),0) INTO v_ordinal;
          INSERT INTO public.hot_updater_v1_insights_report_rows(
            publication_id,section,discriminator,ordinal,order_key,row
          ) VALUES(v_job.id,'movementSeries',v_metric,v_ordinal,v_output_key,
            v_output_row);
          v_bytes:=v_bytes+v_item_bytes; v_processed:=v_processed+1;
          v_job.output_after:=v_next::bigint::text; v_next:=v_next+v_job.bucket_ms;
        END LOOP;
        UPDATE public.hot_updater_v1_insights_report_jobs
        SET output_after=v_job.output_after WHERE id=v_job.id;
        IF v_next>v_end THEN
          INSERT INTO public.hot_updater_v1_insights_report_totals
            (publication_id,section,discriminator,total)
          VALUES(v_job.id,'movementSeries',v_metric,
            ((v_end-v_start)/v_job.bucket_ms+1)::bigint);
          UPDATE public.hot_updater_v1_insights_report_jobs
          SET output_section=output_section+1,output_after=null WHERE id=v_job.id;
        END IF;
      ELSIF v_kind='bundleDetail' AND v_job.output_section IN (2,3) THEN
        v_metric:=CASE v_job.output_section WHEN 2 THEN 'installed'
          ELSE 'recovered' END;
        FOR v_row IN SELECT *
          FROM public.hot_updater_v1_insights_report_counts AS counter
          WHERE counter.job_id=v_job.id AND counter.dimension='movementCohorts'
            AND counter.discriminator=v_metric
            AND (v_job.output_after IS NULL OR
              (counter.group_order,counter.group_digest)>(
                decode(split_part(v_job.output_after,':',1),'hex'),
                decode(split_part(v_job.output_after,':',2),'hex')
              ))
          ORDER BY counter.group_order,counter.group_digest LIMIT p_max_items
        LOOP
          v_output_row:=jsonb_build_object('cohort',v_row.label,'value',v_row.value);
          v_item_bytes:=octet_length(
            public.hot_updater_v1_insights_canonical_json(v_output_row)
          )+96;
          IF v_bytes+v_item_bytes>p_max_bytes THEN EXIT; END IF;
          SELECT coalesce((SELECT report.ordinal+1
            FROM public.hot_updater_v1_insights_report_rows AS report
            WHERE report.publication_id=v_job.id
              AND report.section='movementCohorts'
              AND report.discriminator=v_metric
            ORDER BY report.ordinal DESC LIMIT 1),0) INTO v_ordinal;
          INSERT INTO public.hot_updater_v1_insights_report_rows(
            publication_id,section,discriminator,ordinal,order_key,row
          ) VALUES(v_job.id,'movementCohorts',v_metric,v_ordinal,
            encode(v_row.group_order,'hex')||':'||
              encode(v_row.group_digest,'hex'),v_output_row);
          v_bytes:=v_bytes+v_item_bytes;v_processed:=v_processed+1;
          v_job.output_after:=encode(v_row.group_order,'hex')||':'||
            encode(v_row.group_digest,'hex');
        END LOOP;
        UPDATE public.hot_updater_v1_insights_report_jobs
        SET output_after=v_job.output_after WHERE id=v_job.id;
        SELECT EXISTS(SELECT 1
          FROM public.hot_updater_v1_insights_report_counts AS counter
          WHERE counter.job_id=v_job.id AND counter.dimension='movementCohorts'
            AND counter.discriminator=v_metric AND (v_job.output_after IS NULL OR
              (counter.group_order,counter.group_digest)>(
                decode(split_part(v_job.output_after,':',1),'hex'),
                decode(split_part(v_job.output_after,':',2),'hex')
              )) LIMIT 1)
        INTO v_has_remaining;
        IF NOT v_has_remaining THEN
          SELECT coalesce(total,0) INTO v_total
          FROM public.hot_updater_v1_insights_report_section_totals
          WHERE job_id=v_job.id AND dimension='movementCohorts'
            AND discriminator=v_metric;
          INSERT INTO public.hot_updater_v1_insights_report_totals
            (publication_id,section,discriminator,total)
          VALUES(v_job.id,'movementCohorts',v_metric,coalesce(v_total,0));
          UPDATE public.hot_updater_v1_insights_report_jobs SET
            output_section=output_section+1,output_after=null,
            phase=CASE WHEN output_section=3 THEN 'publish' ELSE phase END
          WHERE id=v_job.id;
        END IF;
      ELSIF (v_kind='installationOverview' AND v_job.output_section=0)
        OR (v_kind='activeOverview' AND v_job.output_section=0)
      THEN
        FOR v_row IN SELECT counter.*,
            lpad((9007199254740991-counter.value)::text,16,'0')||':'||
              counter.bundle_id::text AS rank_key
          FROM public.hot_updater_v1_insights_report_counts AS counter
          WHERE counter.job_id=v_job.id AND counter.dimension='bundleDistribution'
            AND (v_job.output_after IS NULL OR
              (lpad((9007199254740991-counter.value)::text,16,'0')||':'||
                counter.bundle_id::text)>v_job.output_after COLLATE "C")
          ORDER BY counter.value DESC,counter.bundle_id LIMIT p_max_items
        LOOP
          v_output_row:=jsonb_build_object('bundleId',v_row.bundle_id,
            'installations',v_row.value);
          v_item_bytes:=octet_length(
            public.hot_updater_v1_insights_canonical_json(v_output_row)
          )+96;
          IF v_bytes+v_item_bytes>p_max_bytes THEN EXIT; END IF;
          SELECT coalesce((SELECT report.ordinal+1
            FROM public.hot_updater_v1_insights_report_rows AS report
            WHERE report.publication_id=v_job.id
              AND report.section='bundleDistribution'
              AND report.discriminator=''
            ORDER BY report.ordinal DESC LIMIT 1),0) INTO v_ordinal;
          INSERT INTO public.hot_updater_v1_insights_report_rows(
            publication_id,section,bundle_id,ordinal,order_key,row
          ) VALUES(v_job.id,'bundleDistribution',v_row.bundle_id,
            v_ordinal,v_row.rank_key,v_output_row);
          v_bytes:=v_bytes+v_item_bytes;v_processed:=v_processed+1;
          v_job.output_after:=v_row.rank_key;
        END LOOP;
        UPDATE public.hot_updater_v1_insights_report_jobs
        SET output_after=v_job.output_after WHERE id=v_job.id;
        SELECT EXISTS(SELECT 1
          FROM public.hot_updater_v1_insights_report_counts AS counter
          WHERE counter.job_id=v_job.id AND counter.dimension='bundleDistribution'
            AND (v_job.output_after IS NULL OR
              (lpad((9007199254740991-counter.value)::text,16,'0')||':'||
                counter.bundle_id::text)>v_job.output_after COLLATE "C") LIMIT 1)
        INTO v_has_remaining;
        IF NOT v_has_remaining THEN
          SELECT coalesce(total,0) INTO v_total
          FROM public.hot_updater_v1_insights_report_section_totals
          WHERE job_id=v_job.id AND dimension='bundleDistribution'
            AND discriminator='';
          INSERT INTO public.hot_updater_v1_insights_report_totals
            (publication_id,section,total)
          VALUES(v_job.id,'bundleDistribution',coalesce(v_total,0));
          UPDATE public.hot_updater_v1_insights_report_jobs SET
            output_section=output_section+1,output_after=null,
            phase=CASE WHEN v_kind='installationOverview' THEN 'publish'
              ELSE phase END WHERE id=v_job.id;
        END IF;
      ELSIF v_kind='activeOverview' AND v_job.output_section=1 THEN
        v_next:=CASE WHEN v_job.output_after IS NULL THEN v_job.window_start_ms
          ELSE v_job.output_after::double precision+v_job.bucket_ms END;
        v_end:=v_job.last_bucket_ms;
        WHILE v_next<=v_end AND v_processed<p_max_items LOOP
          SELECT coalesce(value,0) INTO v_total
          FROM public.hot_updater_v1_insights_report_counts
          WHERE job_id=v_job.id AND dimension='activeSeries'
            AND group_digest=sha256(convert_to(to_jsonb(
              lpad(v_next::bigint::text,16,'0')
            )::text,'utf8'))
            AND group_key=lpad(v_next::bigint::text,16,'0');
          v_total:=coalesce(v_total,0);
          v_output_row:=jsonb_build_object('bucketStartMs',v_next,'value',v_total);
          v_item_bytes:=octet_length(
            public.hot_updater_v1_insights_canonical_json(v_output_row)
          )+96;
          IF v_bytes+v_item_bytes>p_max_bytes THEN EXIT; END IF;
          v_output_key:=lpad(v_next::bigint::text,16,'0');
          SELECT coalesce((SELECT report.ordinal+1
            FROM public.hot_updater_v1_insights_report_rows AS report
            WHERE report.publication_id=v_job.id
              AND report.section='activeSeries'
              AND report.discriminator=''
            ORDER BY report.ordinal DESC LIMIT 1),0) INTO v_ordinal;
          INSERT INTO public.hot_updater_v1_insights_report_rows(
            publication_id,section,ordinal,order_key,row
          ) VALUES(v_job.id,'activeSeries',v_ordinal,v_output_key,v_output_row);
          v_bytes:=v_bytes+v_item_bytes;v_processed:=v_processed+1;
          v_job.output_after:=v_next::bigint::text;v_next:=v_next+v_job.bucket_ms;
        END LOOP;
        UPDATE public.hot_updater_v1_insights_report_jobs
        SET output_after=v_job.output_after WHERE id=v_job.id;
        IF v_next>v_end THEN
          INSERT INTO public.hot_updater_v1_insights_report_totals
            (publication_id,section,total)
          VALUES(v_job.id,'activeSeries',
            ((v_end-v_job.window_start_ms)/v_job.bucket_ms+1)::bigint);
          UPDATE public.hot_updater_v1_insights_report_jobs
          SET output_section=2,output_after=null WHERE id=v_job.id;
        END IF;
      ELSIF v_kind='activeOverview' AND v_job.output_section=2 THEN
        FOR v_row IN SELECT counter.*,
            lpad((9007199254740991-counter.value)::text,16,'0')||':'||
              counter.bundle_id::text AS rank_key
          FROM public.hot_updater_v1_insights_report_counts AS counter
          WHERE counter.job_id=v_job.id AND counter.dimension='activeBundleRank'
            AND (v_job.output_after IS NULL OR
              (lpad((9007199254740991-counter.value)::text,16,'0')||':'||
                counter.bundle_id::text)>v_job.output_after COLLATE "C")
          ORDER BY counter.value DESC,counter.bundle_id LIMIT p_max_items
        LOOP
          v_item_bytes:=128;
          IF v_bytes+v_item_bytes>p_max_bytes THEN EXIT; END IF;
          INSERT INTO public.hot_updater_v1_insights_report_bundle_order(
            job_id,order_key,bundle_id,observations
          ) VALUES(v_job.id,v_row.rank_key,v_row.bundle_id,v_row.value);
          v_bytes:=v_bytes+v_item_bytes;v_processed:=v_processed+1;
          v_job.output_after:=v_row.rank_key;
        END LOOP;
        UPDATE public.hot_updater_v1_insights_report_jobs
        SET output_after=v_job.output_after WHERE id=v_job.id;
        SELECT EXISTS(SELECT 1
          FROM public.hot_updater_v1_insights_report_counts AS counter
          WHERE counter.job_id=v_job.id AND counter.dimension='activeBundleRank'
            AND (v_job.output_after IS NULL OR
              (lpad((9007199254740991-counter.value)::text,16,'0')||':'||
                counter.bundle_id::text)>v_job.output_after COLLATE "C") LIMIT 1)
        INTO v_has_remaining;
        IF NOT v_has_remaining THEN
          UPDATE public.hot_updater_v1_insights_report_jobs
          SET output_section=3,output_after=null WHERE id=v_job.id;
        END IF;
      ELSE
        WHILE v_processed<p_max_items LOOP
          IF v_job.output_after IS NULL OR
            split_part(v_job.output_after,'|',2)::double precision>=
              v_job.last_bucket_ms
          THEN
            SELECT * INTO v_bundle_order
            FROM public.hot_updater_v1_insights_report_bundle_order AS ordered
            WHERE ordered.job_id=v_job.id AND (v_job.output_after IS NULL OR
              ordered.order_key>
                split_part(v_job.output_after,'|',1) COLLATE "C")
            ORDER BY ordered.order_key LIMIT 1;
            IF NOT FOUND THEN
              SELECT coalesce(total,0) INTO v_total
              FROM public.hot_updater_v1_insights_report_section_totals
              WHERE job_id=v_job.id AND dimension='activeBundleRank'
                AND discriminator='';
              INSERT INTO public.hot_updater_v1_insights_report_totals
                (publication_id,section,total)
              VALUES(v_job.id,'activeBundleSeries',coalesce(v_total,0)*
                ((v_job.last_bucket_ms-v_job.window_start_ms)/
                  v_job.bucket_ms+1)::bigint);
              v_job.output_after:=null;
              UPDATE public.hot_updater_v1_insights_report_jobs
              SET phase='publish',output_after=null WHERE id=v_job.id;
              EXIT;
            END IF;
            v_next:=v_job.window_start_ms;
          ELSE
            SELECT * INTO v_bundle_order
            FROM public.hot_updater_v1_insights_report_bundle_order AS ordered
            WHERE ordered.job_id=v_job.id
              AND ordered.order_key=split_part(v_job.output_after,'|',1);
            IF NOT FOUND THEN
              RAISE EXCEPTION 'INSIGHTS_STORAGE_CORRUPTION'
                USING ERRCODE='P0001';
            END IF;
            v_next:=split_part(v_job.output_after,'|',2)::double precision+
              v_job.bucket_ms;
          END IF;
          WHILE v_next<=v_job.last_bucket_ms AND v_processed<p_max_items LOOP
            SELECT coalesce(value,0) INTO v_total
            FROM public.hot_updater_v1_insights_report_counts
            WHERE job_id=v_job.id AND dimension='activeBundleSeries'
              AND group_digest=sha256(convert_to(to_jsonb(
                v_bundle_order.bundle_id::text||':'||
                  lpad(v_next::bigint::text,16,'0')
              )::text,'utf8'))
              AND group_key=v_bundle_order.bundle_id::text||':'||
                lpad(v_next::bigint::text,16,'0');
            v_total:=coalesce(v_total,0);
            v_output_row:=jsonb_build_object('bundleId',v_bundle_order.bundle_id,
              'bucketStartMs',v_next,'value',v_total);
            v_item_bytes:=octet_length(
              public.hot_updater_v1_insights_canonical_json(v_output_row)
            )+112;
            IF v_bytes+v_item_bytes>p_max_bytes THEN EXIT; END IF;
            v_output_key:=v_bundle_order.order_key||':'||
              lpad(v_next::bigint::text,16,'0');
            SELECT coalesce((SELECT report.ordinal+1
              FROM public.hot_updater_v1_insights_report_rows AS report
              WHERE report.publication_id=v_job.id
                AND report.section='activeBundleSeries'
                AND report.discriminator=''
              ORDER BY report.ordinal DESC LIMIT 1),0) INTO v_ordinal;
            INSERT INTO public.hot_updater_v1_insights_report_rows(
              publication_id,section,bundle_id,ordinal,order_key,row
            ) VALUES(v_job.id,'activeBundleSeries',v_bundle_order.bundle_id,
              v_ordinal,v_output_key,v_output_row);
            v_bytes:=v_bytes+v_item_bytes;v_processed:=v_processed+1;
            v_job.output_after:=v_bundle_order.order_key||'|'||v_next::bigint::text;
            v_next:=v_next+v_job.bucket_ms;
          END LOOP;
          IF v_next<=v_job.last_bucket_ms THEN EXIT; END IF;
          INSERT INTO public.hot_updater_v1_insights_report_totals(
            publication_id,section,bundle_key,total
          ) VALUES(v_job.id,'activeBundleSeries',v_bundle_order.bundle_id::text,
            ((v_job.last_bucket_ms-v_job.window_start_ms)/v_job.bucket_ms+1)::bigint)
          ON CONFLICT DO NOTHING;
        END LOOP;
        UPDATE public.hot_updater_v1_insights_report_jobs
        SET output_after=v_job.output_after WHERE id=v_job.id;
      END IF;
      UPDATE public.hot_updater_v1_insights_report_jobs
      SET lease_owner=null,lease_expires_at_ms=null WHERE id=v_job.id;
      RETURN jsonb_build_object('state','running','jobId',v_job.id,
        'sourceGeneration',v_job.source_generation,'processed',v_processed,
        'bytes',v_bytes);
    END IF;

    SELECT * INTO v_job FROM public.hot_updater_v1_insights_report_jobs
    WHERE id=v_job.id FOR UPDATE;
    v_summary:=CASE v_kind
      WHEN 'bundleSummaries' THEN v_job.summary
      WHEN 'bundleDetail' THEN jsonb_build_object(
        'installed',v_job.installed_count,'recovered',v_job.recovered_count)
      WHEN 'installationOverview' THEN jsonb_build_object(
        'trackedInstallations',v_job.tracked_count)
      ELSE jsonb_build_object('activeInstallations',v_job.active_count) END;
    UPDATE public.hot_updater_v1_insights_publications SET
      summary=v_summary,visible=true,
      completed_at_ms=greatest(v_job.as_of_ms,
        floor(extract(epoch FROM clock_timestamp())*1000)::double precision)
    WHERE id=v_job.id AND NOT visible;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'INSIGHTS_REPORT_PUBLICATION_LOST' USING ERRCODE='P0001';
    END IF;
    UPDATE public.hot_updater_v1_insights_report_jobs SET state='ready',
      completed_at_ms=greatest(v_job.as_of_ms,
        floor(extract(epoch FROM clock_timestamp())*1000)::double precision),
      lease_owner=null,lease_expires_at_ms=null
    WHERE id=v_job.id AND lease_owner=v_lease_owner AND lease_epoch=v_lease_epoch;
    RETURN jsonb_build_object('state','complete','jobId',v_job.id,
      'publicationId',v_job.id,'sourceGeneration',v_job.source_generation,
      'processed',0,'bytes',0);
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    GET STACKED DIAGNOSTICS v_error_message = MESSAGE_TEXT;
    IF v_error_message <> 'INSIGHTS_STORAGE_CORRUPTION' THEN
      RAISE;
    END IF;
    UPDATE public.hot_updater_v1_insights_report_jobs SET state='failed',
      error='migration-poison',
      completed_at_ms=floor(extract(epoch FROM clock_timestamp())*1000),
      lease_owner=null,lease_expires_at_ms=null
    WHERE id=v_job.id AND lease_owner=v_lease_owner AND lease_epoch=v_lease_epoch
    RETURNING * INTO v_job;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'INSIGHTS_REPORT_LEASE_LOST' USING ERRCODE='P0001';
    END IF;
    RETURN jsonb_build_object('state','failed','jobId',v_job.id,
      'sourceGeneration',v_job.source_generation,'processed',v_processed,
      'bytes',v_bytes);
  END;
END;
$$;
REVOKE ALL ON FUNCTION public.hot_updater_v1_insights_report_step(
  uuid, text, integer, integer
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hot_updater_v1_insights_report_step(
  uuid, text, integer, integer
) TO service_role;

CREATE FUNCTION public.hot_updater_v1_insights_report_page(
  p_database_namespace uuid,
  p_publication_id text,
  p_section jsonb,
  p_limit integer,
  p_after jsonb DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_publication public.hot_updater_v1_insights_publications;
  v_section text := p_section->>'section';
  v_discriminator text := coalesce(p_section->>'metric', '');
  v_bundle_id uuid;
  v_after text := CASE WHEN p_after IS NULL THEN '0' ELSE p_after #>> '{}' END;
  v_start_ordinal bigint;
  v_page_start bigint;
  v_stream_start bigint := 0;
  v_total bigint;
  v_result jsonb;
  v_known_bundle boolean := true;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100
    OR jsonb_typeof(p_section) <> 'object'
    OR v_section NOT IN (
      'movementSeries', 'movementCohorts', 'bundleDistribution',
      'activeSeries', 'activeBundleSeries'
    )
    OR (v_section IN ('movementSeries', 'movementCohorts')
      AND v_discriminator NOT IN ('installed', 'recovered'))
    OR (p_after IS NOT NULL AND jsonb_typeof(p_after) <> 'string')
    OR v_after !~ '^(0|[1-9][0-9]*)$'
    OR length(v_after) > 19
    OR (length(v_after) = 19 AND v_after > '9223372036854775807')
  THEN
    RAISE EXCEPTION 'Invalid report page input' USING ERRCODE = '22023';
  END IF;
  PERFORM public.hot_updater_v1_insights_require_namespace(
    p_database_namespace
  );
  IF NOT coalesce(public.hot_updater_v1_insights_layout_ready('report'), false)
  THEN
    RAISE EXCEPTION 'INSIGHTS_STORAGE_NOT_READY' USING ERRCODE = 'P0001';
  END IF;
  v_start_ordinal := v_after::bigint;
  IF v_section = 'activeBundleSeries' AND p_section ? 'bundleId'
    AND p_section->>'bundleId' IS NOT NULL
  THEN
    BEGIN v_bundle_id := (p_section->>'bundleId')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'Invalid report bundle filter' USING ERRCODE = '22023';
    END;
  END IF;

  SELECT * INTO v_publication
  FROM public.hot_updater_v1_insights_publications AS publication
  WHERE publication.id = p_publication_id AND publication.visible;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('state', 'expired');
  END IF;
  IF (v_publication.kind = 'bundleDetail' AND
      v_section NOT IN ('movementSeries', 'movementCohorts'))
    OR (v_publication.kind = 'installationOverview' AND
      v_section <> 'bundleDistribution')
    OR (v_publication.kind = 'activeOverview' AND
      v_section NOT IN ('bundleDistribution', 'activeSeries', 'activeBundleSeries'))
    OR v_publication.kind = 'bundleSummaries'
  THEN
    RAISE EXCEPTION 'Invalid report section for publication'
      USING ERRCODE = '22023';
  END IF;

  IF v_bundle_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM public.hot_updater_v1_insights_report_bundle_order AS bundle
      WHERE bundle.job_id=p_publication_id AND bundle.bundle_id=v_bundle_id
    ) INTO v_known_bundle;
  END IF;
  IF v_known_bundle THEN
    SELECT totals.total INTO v_total
    FROM public.hot_updater_v1_insights_report_totals AS totals
    WHERE totals.publication_id = p_publication_id
      AND totals.section = v_section
      AND totals.discriminator = v_discriminator
      AND totals.bundle_key = coalesce(v_bundle_id::text, '');
    IF NOT FOUND THEN
      RAISE EXCEPTION 'INSIGHTS_STORAGE_CORRUPTION' USING ERRCODE='P0001';
    END IF;
  ELSE
    IF EXISTS (
      SELECT 1 FROM public.hot_updater_v1_insights_report_totals AS totals
      WHERE totals.publication_id=p_publication_id
        AND totals.section=v_section
        AND totals.discriminator=v_discriminator
        AND totals.bundle_key=v_bundle_id::text
    ) OR EXISTS (
      SELECT 1 FROM public.hot_updater_v1_insights_report_rows AS report
      WHERE report.publication_id=p_publication_id
        AND report.section=v_section
        AND report.discriminator=v_discriminator
        AND report.bundle_id=v_bundle_id
    ) THEN
      RAISE EXCEPTION 'INSIGHTS_STORAGE_CORRUPTION' USING ERRCODE='P0001';
    END IF;
    v_total:=0;
  END IF;
  IF v_bundle_id IS NOT NULL THEN
    SELECT min(report.ordinal) INTO v_stream_start
    FROM public.hot_updater_v1_insights_report_rows AS report
    WHERE report.publication_id=p_publication_id
      AND report.section=v_section
      AND report.discriminator=v_discriminator
      AND report.bundle_id=v_bundle_id;
    IF v_total > 0 AND v_stream_start IS NULL THEN
      RAISE EXCEPTION 'INSIGHTS_STORAGE_CORRUPTION' USING ERRCODE='P0001';
    END IF;
    v_stream_start:=coalesce(v_stream_start,0);
  END IF;
  v_page_start:=CASE WHEN v_start_ordinal=0 THEN v_stream_start
    ELSE v_start_ordinal END;
  IF p_after IS NOT NULL AND (
    v_page_start < v_stream_start OR
    v_page_start-v_stream_start >= v_total
  ) THEN
    IF EXISTS (
      SELECT 1 FROM public.hot_updater_v1_insights_report_rows AS report
      WHERE report.publication_id=p_publication_id
        AND report.section=v_section
        AND report.discriminator=v_discriminator
        AND (v_bundle_id IS NULL OR report.bundle_id=v_bundle_id)
        AND report.ordinal >= v_page_start
      LIMIT 1
    ) THEN
      RAISE EXCEPTION 'INSIGHTS_STORAGE_CORRUPTION' USING ERRCODE='P0001';
    END IF;
    RAISE EXCEPTION 'Invalid report page cursor' USING ERRCODE='22023';
  ELSIF v_page_start < v_stream_start OR
    v_page_start-v_stream_start > v_total
  THEN
    RAISE EXCEPTION 'INSIGHTS_STORAGE_CORRUPTION' USING ERRCODE='P0001';
  END IF;

  v_result := (
    WITH candidates AS MATERIALIZED (
      SELECT report.*
      FROM public.hot_updater_v1_insights_report_rows AS report
      WHERE report.publication_id = p_publication_id
        AND report.section = v_section
        AND report.discriminator = v_discriminator
        AND (v_bundle_id IS NULL OR report.bundle_id = v_bundle_id)
        AND report.ordinal >= v_page_start
      ORDER BY report.ordinal LIMIT p_limit + 1
    ), page AS (
      SELECT * FROM candidates ORDER BY ordinal LIMIT p_limit
    )
    SELECT jsonb_build_object(
      'state', 'ready',
      'rows', coalesce((SELECT jsonb_agg(page.row ORDER BY page.ordinal)
        FROM page), '[]'::jsonb),
      'hasMore', v_total > v_page_start-v_stream_start+
        (SELECT count(*) FROM page),
      'candidateReads', (SELECT count(*) FROM candidates),
      'corrupt', (SELECT count(*) FROM candidates) <> least(
        p_limit + 1, greatest(
          v_total - (v_page_start-v_stream_start), 0
        )
      ) OR EXISTS (
        SELECT 1 FROM (
          SELECT candidate.ordinal,
            row_number() OVER (ORDER BY candidate.ordinal) AS position
          FROM candidates AS candidate
        ) AS ordered
        WHERE ordered.ordinal <> v_page_start + ordered.position - 1
      ),
      'last', (SELECT to_jsonb((page.ordinal + 1)::text) FROM page
        ORDER BY page.ordinal DESC LIMIT 1),
      'total', v_total,
      'publication', jsonb_build_object(
        'asOfMs', v_publication.as_of_ms,
        'completedAtMs', v_publication.completed_at_ms,
        'sourceGeneration', v_publication.source_generation
      )
    )
  );
  IF (v_result->>'corrupt')::boolean THEN
    RAISE EXCEPTION 'INSIGHTS_STORAGE_CORRUPTION' USING ERRCODE='P0001';
  END IF;
  RETURN v_result - 'corrupt';
END;
$$;

REVOKE ALL ON FUNCTION public.hot_updater_v1_insights_report_page(
  uuid, text, jsonb, integer, jsonb
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hot_updater_v1_insights_report_page(
  uuid, text, jsonb, integer, jsonb
) TO service_role;

CREATE FUNCTION public.hot_updater_v1_insights_prune(
  p_database_namespace uuid,
  p_before_ms double precision,
  p_max_items integer,
  p_max_bytes integer
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_kind text;
  v_job_id text;
  v_table text;
  v_owner_column text;
  v_order text;
  v_processed integer := 0;
  v_bytes bigint := 0;
  v_item_bytes bigint;
BEGIN
  IF p_before_ms IS NULL OR p_before_ms < 0
    OR p_before_ms > 9007199254740991 OR p_before_ms <> trunc(p_before_ms)
    OR p_max_items IS NULL OR p_max_items NOT BETWEEN 1 AND 4096
    OR p_max_bytes IS NULL OR p_max_bytes NOT BETWEEN 1 AND 4194304
  THEN
    RAISE EXCEPTION 'Invalid Insights retention input' USING ERRCODE='22023';
  END IF;
  PERFORM public.hot_updater_v1_insights_bind_namespace(
    p_database_namespace
  );
  IF NOT coalesce(
    public.hot_updater_v1_insights_layout_ready('retention'), false
  ) THEN
    RAISE EXCEPTION 'INSIGHTS_STORAGE_NOT_READY' USING ERRCODE='P0001';
  END IF;
  PERFORM pg_advisory_xact_lock(
    hashtextextended('supabase-insights-retention-v2', 0)
  );

  SELECT expired.kind, expired.id INTO v_kind, v_job_id
  FROM (
    SELECT 'search'::text AS kind, job.id, job.completed_at_ms
    FROM public.hot_updater_v1_insights_search_jobs AS job
    WHERE job.state IN ('ready','failed')
      AND job.completed_at_ms < p_before_ms
    UNION ALL
    SELECT 'report', job.id, job.completed_at_ms
    FROM public.hot_updater_v1_insights_report_jobs AS job
    WHERE job.state IN ('ready','failed')
      AND job.completed_at_ms < p_before_ms
  ) AS expired
  ORDER BY expired.completed_at_ms, expired.kind, expired.id COLLATE "C"
  LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('state','complete','processed',0,'bytes',0);
  END IF;

  -- Make the immutable publication unreachable in the same transaction as
  -- the first GC step. Later bounded steps may delete children safely.
  IF v_kind = 'search' THEN
    UPDATE public.hot_updater_v1_insights_search_jobs
    SET visible=false WHERE id=v_job_id AND visible;
  ELSE
    UPDATE public.hot_updater_v1_insights_report_jobs
    SET visible=false WHERE id=v_job_id AND visible;
    UPDATE public.hot_updater_v1_insights_publications
    SET visible=false WHERE id=v_job_id AND visible;
  END IF;

  IF v_kind = 'search' THEN
    IF EXISTS (SELECT 1 FROM public.hot_updater_v1_insights_search_results
      WHERE job_id=v_job_id LIMIT 1) THEN
      v_table:='hot_updater_v1_insights_search_results';
      v_owner_column:='job_id'; v_order:='install_key';
    ELSIF EXISTS (SELECT 1 FROM public.hot_updater_v1_insights_search_members
      WHERE job_id=v_job_id LIMIT 1) THEN
      v_table:='hot_updater_v1_insights_search_members';
      v_owner_column:='job_id'; v_order:='install_key';
    END IF;
  ELSE
    IF EXISTS (SELECT 1 FROM public.hot_updater_v1_insights_report_rows
      WHERE publication_id=v_job_id LIMIT 1) THEN
      v_table:='hot_updater_v1_insights_report_rows';
      v_owner_column:='publication_id';
      v_order:='section,discriminator,ordinal';
    ELSIF EXISTS (SELECT 1 FROM public.hot_updater_v1_insights_report_totals
      WHERE publication_id=v_job_id LIMIT 1) THEN
      v_table:='hot_updater_v1_insights_report_totals';
      v_owner_column:='publication_id';
      v_order:='section,discriminator,bundle_key';
    ELSIF EXISTS (SELECT 1 FROM public.hot_updater_v1_insights_report_members
      WHERE job_id=v_job_id LIMIT 1) THEN
      v_table:='hot_updater_v1_insights_report_members';
      v_owner_column:='job_id';
      v_order:='dimension,discriminator,group_digest,install_key';
    ELSIF EXISTS (SELECT 1 FROM public.hot_updater_v1_insights_report_counts
      WHERE job_id=v_job_id LIMIT 1) THEN
      v_table:='hot_updater_v1_insights_report_counts';
      v_owner_column:='job_id';
      v_order:='dimension,discriminator,group_digest';
    ELSIF EXISTS (SELECT 1
      FROM public.hot_updater_v1_insights_report_section_totals
      WHERE job_id=v_job_id LIMIT 1) THEN
      v_table:='hot_updater_v1_insights_report_section_totals';
      v_owner_column:='job_id'; v_order:='dimension,discriminator';
    ELSIF EXISTS (SELECT 1 FROM public.hot_updater_v1_insights_report_latest
      WHERE job_id=v_job_id LIMIT 1) THEN
      v_table:='hot_updater_v1_insights_report_latest';
      v_owner_column:='job_id';
      v_order:='install_key,bucket_start_ms';
    ELSIF EXISTS (
      SELECT 1 FROM public.hot_updater_v1_insights_report_bundle_order
      WHERE job_id=v_job_id LIMIT 1
    ) THEN
      v_table:='hot_updater_v1_insights_report_bundle_order';
      v_owner_column:='job_id'; v_order:='order_key';
    END IF;
  END IF;

  IF v_table IS NOT NULL THEN
    EXECUTE format(
      'WITH candidates AS MATERIALIZED (
         SELECT child.ctid,
           octet_length(public.hot_updater_v1_insights_canonical_json(
             to_jsonb(child)))+64 AS item_bytes
         FROM public.%I AS child WHERE child.%I=$1
         ORDER BY %s LIMIT $2
       ), measured AS (
         SELECT candidate.*,
           sum(candidate.item_bytes) OVER (ORDER BY candidate.ctid)
             AS cumulative_bytes
         FROM candidates AS candidate
       ), step AS MATERIALIZED (
         SELECT * FROM measured WHERE cumulative_bytes<=$3
       ), deleted AS (
         DELETE FROM public.%I AS child USING step
         WHERE child.ctid=step.ctid RETURNING 1
       )
       SELECT (SELECT count(*) FROM deleted)::integer,
         coalesce((SELECT max(cumulative_bytes) FROM step),0)::bigint',
      v_table, v_owner_column, v_order, v_table
    ) INTO v_processed, v_bytes USING v_job_id, p_max_items, p_max_bytes;
    RETURN jsonb_build_object('state','running','processed',v_processed,
      'bytes',v_bytes);
  END IF;

  IF v_kind = 'report' AND EXISTS (
    SELECT 1 FROM public.hot_updater_v1_insights_publications
    WHERE id=v_job_id
  ) THEN
    SELECT octet_length(public.hot_updater_v1_insights_canonical_json(
      to_jsonb(publication)))+64 INTO v_item_bytes
    FROM public.hot_updater_v1_insights_publications AS publication
    WHERE publication.id=v_job_id;
    IF v_item_bytes > p_max_bytes THEN
      RETURN jsonb_build_object('state','running','processed',0,'bytes',0);
    END IF;
    DELETE FROM public.hot_updater_v1_insights_publications WHERE id=v_job_id;
  ELSE
    IF v_kind = 'search' THEN
      SELECT octet_length(public.hot_updater_v1_insights_canonical_json(
        to_jsonb(job)))+64 INTO v_item_bytes
      FROM public.hot_updater_v1_insights_search_jobs AS job
      WHERE job.id=v_job_id;
      IF v_item_bytes <= p_max_bytes THEN
        DELETE FROM public.hot_updater_v1_insights_search_jobs WHERE id=v_job_id;
      END IF;
    ELSE
      SELECT octet_length(public.hot_updater_v1_insights_canonical_json(
        to_jsonb(job)))+64 INTO v_item_bytes
      FROM public.hot_updater_v1_insights_report_jobs AS job
      WHERE job.id=v_job_id;
      IF v_item_bytes <= p_max_bytes THEN
        DELETE FROM public.hot_updater_v1_insights_report_jobs WHERE id=v_job_id;
      END IF;
    END IF;
    IF v_item_bytes > p_max_bytes THEN
      RETURN jsonb_build_object('state','running','processed',0,'bytes',0);
    END IF;
  END IF;
  RETURN jsonb_build_object('state','running','processed',1,
    'bytes',v_item_bytes);
END;
$$;
REVOKE ALL ON FUNCTION public.hot_updater_v1_insights_prune(
  uuid, double precision, integer, integer
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hot_updater_v1_insights_prune(
  uuid, double precision, integer, integer
) TO service_role;

-- Supabase can grant newly created public objects through default privileges.
-- These tables are private implementation state and remain accessible only
-- through the fenced scalar RPCs above, including to BYPASSRLS service roles.
REVOKE ALL ON TABLE
  public.hot_updater_v1_bundle_events,
  public.hot_updater_v1_insights_source_state,
  public.hot_updater_v1_insights_live_installations,
  public.hot_updater_v1_insights_installation_versions,
  public.hot_updater_v1_insights_aliases,
  public.hot_updater_v1_insights_search_jobs,
  public.hot_updater_v1_insights_search_members,
  public.hot_updater_v1_insights_search_results,
  public.hot_updater_v1_insights_publications,
  public.hot_updater_v1_insights_report_jobs,
  public.hot_updater_v1_insights_report_members,
  public.hot_updater_v1_insights_report_counts,
  public.hot_updater_v1_insights_report_section_totals,
  public.hot_updater_v1_insights_report_latest,
  public.hot_updater_v1_insights_report_bundle_order,
  public.hot_updater_v1_insights_report_rows,
  public.hot_updater_v1_insights_report_totals
FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE public.hot_updater_v1_insights_aliases_id_seq
  FROM PUBLIC, anon, authenticated, service_role;

UPDATE public.hot_updater_v1_insights_source_state AS source
SET layout = jsonb_build_object(
  'migration', public.hot_updater_v1_insights_layout_digest('migration'),
  'append', public.hot_updater_v1_insights_layout_digest('append'),
  'event', public.hot_updater_v1_insights_layout_digest('event'),
  'installation', public.hot_updater_v1_insights_layout_digest('installation'),
  'search', public.hot_updater_v1_insights_layout_digest('search'),
  'report', public.hot_updater_v1_insights_layout_digest('report'),
  'retention', public.hot_updater_v1_insights_layout_digest('retention'),
  'maintenance', public.hot_updater_v1_insights_layout_digest('maintenance')
)
WHERE source.id = 1 AND source.version = 2;

NOTIFY pgrst, 'reload schema';
