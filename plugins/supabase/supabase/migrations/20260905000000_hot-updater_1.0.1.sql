-- HotUpdater.insights-1.0.1
-- Preserve existing reports while adding the fixed Insights query paths.
ALTER TABLE public.hot_updater_v1_bundle_events ALTER COLUMN install_id TYPE text COLLATE "C";
ALTER TABLE public.hot_updater_v1_bundle_events ALTER COLUMN user_id TYPE text COLLATE "C";
ALTER TABLE public.hot_updater_v1_bundle_events ALTER COLUMN platform TYPE text COLLATE "C";
ALTER TABLE public.hot_updater_v1_bundle_events ALTER COLUMN channel TYPE text COLLATE "C";
ALTER TABLE public.hot_updater_v1_bundle_installations ALTER COLUMN install_id TYPE text COLLATE "C";
ALTER TABLE public.hot_updater_v1_bundle_installations ALTER COLUMN user_id TYPE text COLLATE "C";
ALTER TABLE public.hot_updater_v1_bundle_installations ALTER COLUMN platform TYPE text COLLATE "C";
ALTER TABLE public.hot_updater_v1_bundle_installations ALTER COLUMN channel TYPE text COLLATE "C";
CREATE INDEX IF NOT EXISTS hot_updater_v1_bundle_events_from_bundle_idx ON public.hot_updater_v1_bundle_events(type, platform, channel, from_bundle_id, received_at_ms, id);
CREATE INDEX IF NOT EXISTS hot_updater_v1_bundle_events_to_bundle_idx ON public.hot_updater_v1_bundle_events(type, platform, channel, to_bundle_id, received_at_ms, id);
CREATE INDEX IF NOT EXISTS hot_updater_v1_bundle_installations_scope_idx ON public.hot_updater_v1_bundle_installations(platform, channel, received_at_ms);
CREATE INDEX IF NOT EXISTS hot_updater_v1_bundle_installations_bundle_idx ON public.hot_updater_v1_bundle_installations(platform, channel, to_bundle_id, received_at_ms);
INSERT INTO public.hot_updater_v1_private_settings(key, value) VALUES ('schema.core', '1.0.1') ON CONFLICT (key) DO UPDATE SET value = excluded.value;

-- The event insert gates the snapshot replacement in the same SQL statement.
CREATE FUNCTION public.hot_updater_v1_record_insights(p_event jsonb, p_installation jsonb)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH accepted_event AS (
    INSERT INTO public.hot_updater_v1_bundle_events
    SELECT * FROM pg_catalog.jsonb_populate_record(
      NULL::public.hot_updater_v1_bundle_events, p_event
    )
    ON CONFLICT (id) DO NOTHING RETURNING id
  )
  INSERT INTO public.hot_updater_v1_bundle_installations
  SELECT candidate.*
  FROM pg_catalog.jsonb_populate_record(
    NULL::public.hot_updater_v1_bundle_installations, p_installation
  ) AS candidate
  CROSS JOIN accepted_event
  ON CONFLICT (install_id) DO UPDATE SET
    id = excluded.id,
    user_id = excluded.user_id,
    username = excluded.username,
    to_bundle_id = excluded.to_bundle_id,
    type = excluded.type,
    platform = excluded.platform,
    app_version = excluded.app_version,
    channel = excluded.channel,
    cohort = excluded.cohort,
    received_at_ms = excluded.received_at_ms
  WHERE (excluded.received_at_ms, excluded.id) >
    (hot_updater_v1_bundle_installations.received_at_ms,
      hot_updater_v1_bundle_installations.id);
$$;

REVOKE EXECUTE ON FUNCTION public.hot_updater_v1_record_insights(jsonb, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hot_updater_v1_record_insights(jsonb, jsonb)
  TO service_role;

NOTIFY pgrst, 'reload schema';
