-- HotUpdater.insightsEventPage

CREATE INDEX hot_updater_v1_bundle_events_install_type_idx
  ON public.hot_updater_v1_bundle_events(install_id, type, received_at_ms, id);

CREATE FUNCTION public.hot_updater_v1_insights_event_page(
  p_scope text,
  p_scope_id text,
  p_before_received_at_ms double precision,
  p_limit integer,
  p_cursor_received_at_ms double precision DEFAULT NULL,
  p_cursor_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_indexes jsonb;
  v_boundary_ms double precision;
  v_boundary_id uuid;
  v_bundle_id uuid;
BEGIN
  IF p_scope IS NULL OR p_scope NOT IN ('all', 'installation', 'bundle')
    OR p_limit IS NULL OR p_limit < 1 OR p_limit > 100
    OR p_before_received_at_ms IS NULL
    OR NOT (p_before_received_at_ms BETWEEN 0 AND 9007199254740991
      AND p_before_received_at_ms = trunc(p_before_received_at_ms))
    OR (p_scope = 'all' AND p_scope_id IS NOT NULL)
    OR (p_scope <> 'all' AND (p_scope_id IS NULL
      OR char_length(p_scope_id) NOT BETWEEN 1 AND 1024))
    OR ((p_cursor_received_at_ms IS NULL) <> (p_cursor_id IS NULL))
    OR (p_cursor_received_at_ms IS NOT NULL AND NOT (
      p_cursor_received_at_ms >= 0
      AND p_cursor_received_at_ms < p_before_received_at_ms
      AND p_cursor_received_at_ms = trunc(p_cursor_received_at_ms)))
  THEN
    RAISE EXCEPTION 'Invalid Insights event page input' USING ERRCODE = '22023';
  END IF;

  v_boundary_ms := coalesce(p_cursor_received_at_ms, p_before_received_at_ms);
  v_boundary_id := coalesce(p_cursor_id, '00000000-0000-0000-0000-000000000000'::uuid);
  IF p_scope = 'bundle' THEN
    v_bundle_id := p_scope_id::uuid;
  END IF;

  -- Inspect the actual index layout on every page. A missing index must not
  -- silently turn this path into a history scan, including on warm instances.
  SELECT coalesce(jsonb_agg(to_jsonb(layout.columns)), '[]'::jsonb)
  INTO v_indexes
  FROM (
    SELECT ARRAY(SELECT pg_get_indexdef(i.indexrelid, n, false)
      FROM generate_series(1, i.indnkeyatts) n) AS columns
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_am am ON am.oid = c.relam
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attname = 'id'
    WHERE i.indrelid = to_regclass('public.hot_updater_v1_bundle_events')
      AND a.atttypid = 'uuid'::regtype
      AND i.indisvalid AND i.indisready
      AND i.indpred IS NULL AND i.indexprs IS NULL
      AND am.amname = 'btree'
      AND NOT EXISTS (SELECT 1 FROM unnest(i.indoption) option_bits
        WHERE option_bits <> 0)
      AND NOT EXISTS (SELECT 1 FROM unnest(i.indclass) class_id
        JOIN pg_opclass opclass ON opclass.oid = class_id
        WHERE NOT opclass.opcdefault)
  ) layout;

  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(CASE p_scope
      WHEN 'all' THEN '[["received_at_ms", "id"]]'::jsonb
      WHEN 'installation' THEN '[["install_id", "type", "received_at_ms", "id"]]'::jsonb
      ELSE '[["type", "to_bundle_id", "received_at_ms", "id"],
        ["type", "from_bundle_id", "received_at_ms", "id"]]'::jsonb
    END) required(columns)
    WHERE NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_indexes) actual(columns)
      WHERE actual.columns = required.columns
    )
  )
  THEN
    RAISE EXCEPTION 'INSIGHTS_QUERY_NOT_READY' USING ERRCODE = 'P0001';
  END IF;

  -- Each active stream reads N + 1 candidates before the bounded merge.
  -- Inactive scope branches have a one-time false filter and read no events.
  RETURN (
    -- Insights.pageQuery.start
    WITH candidates AS MATERIALIZED (
      (SELECT e.* FROM public.hot_updater_v1_bundle_events e
        WHERE p_scope = 'all'
          AND (e.received_at_ms, e.id) < (v_boundary_ms, v_boundary_id)
        ORDER BY e.received_at_ms DESC, e.id DESC LIMIT p_limit + 1)
      UNION ALL
      (SELECT e.* FROM public.hot_updater_v1_bundle_events e
        WHERE p_scope = 'installation'
          AND e.install_id = p_scope_id AND e.type = 'UPDATE_APPLIED'
          AND (e.received_at_ms, e.id) < (v_boundary_ms, v_boundary_id)
        ORDER BY e.received_at_ms DESC, e.id DESC LIMIT p_limit + 1)
      UNION ALL
      (SELECT e.* FROM public.hot_updater_v1_bundle_events e
        WHERE p_scope = 'installation'
          AND e.install_id = p_scope_id AND e.type = 'RECOVERED'
          AND (e.received_at_ms, e.id) < (v_boundary_ms, v_boundary_id)
        ORDER BY e.received_at_ms DESC, e.id DESC LIMIT p_limit + 1)
      UNION ALL
      (SELECT e.* FROM public.hot_updater_v1_bundle_events e
        WHERE p_scope = 'bundle'
          AND e.to_bundle_id = v_bundle_id AND e.type = 'UPDATE_APPLIED'
          AND (e.received_at_ms, e.id) < (v_boundary_ms, v_boundary_id)
        ORDER BY e.received_at_ms DESC, e.id DESC LIMIT p_limit + 1)
      UNION ALL
      (SELECT e.* FROM public.hot_updater_v1_bundle_events e
        WHERE p_scope = 'bundle'
          AND e.from_bundle_id = v_bundle_id AND e.type = 'RECOVERED'
          AND (e.received_at_ms, e.id) < (v_boundary_ms, v_boundary_id)
        ORDER BY e.received_at_ms DESC, e.id DESC LIMIT p_limit + 1)
    ), page AS (
      SELECT * FROM candidates
      ORDER BY received_at_ms DESC, id DESC LIMIT p_limit
    )
    SELECT jsonb_build_object(
      'rows', coalesce((SELECT jsonb_agg(to_jsonb(page)
        ORDER BY received_at_ms DESC, id DESC) FROM page), '[]'::jsonb),
      'hasMore', (SELECT count(*) > p_limit FROM candidates)
    )
    -- Insights.pageQuery.end
  );
END;
$$;

REVOKE ALL ON FUNCTION public.hot_updater_v1_insights_event_page(
  text, text, double precision, integer, double precision, uuid
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hot_updater_v1_insights_event_page(
  text, text, double precision, integer, double precision, uuid
) TO service_role;
GRANT SELECT ON public.hot_updater_v1_bundle_events TO service_role;

NOTIFY pgrst, 'reload schema';
