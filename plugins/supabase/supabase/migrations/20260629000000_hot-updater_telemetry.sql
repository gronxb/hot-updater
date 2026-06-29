CREATE TABLE IF NOT EXISTS public.telemetry_keys (
  id text PRIMARY KEY DEFAULT 'default',
  key_hash text NOT NULL,
  key_suffix text NOT NULL CHECK (char_length(key_suffix) = 8),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT telemetry_keys_singleton CHECK (id = 'default')
);

CREATE TABLE IF NOT EXISTS public.bundle_lifecycle_events (
  event_id text PRIMARY KEY,
  bundle_id uuid NOT NULL,
  channel text NOT NULL,
  platform public.platforms NOT NULL,
  status text NOT NULL CHECK (status IN ('ACTIVE', 'RECOVERED')),
  install_id text NOT NULL,
  crashed_bundle_id uuid,
  observed_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bundle_lifecycle_recovered_crash_required CHECK (
    status <> 'RECOVERED' OR crashed_bundle_id IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS bundle_lifecycle_events_bundle_id_idx
  ON public.bundle_lifecycle_events(bundle_id);

CREATE INDEX IF NOT EXISTS bundle_lifecycle_events_crashed_bundle_id_idx
  ON public.bundle_lifecycle_events(crashed_bundle_id)
  WHERE crashed_bundle_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.bundle_lifecycle_metrics (
  bundle_id uuid NOT NULL,
  bucket_start timestamptz NOT NULL,
  channel text NOT NULL,
  platform public.platforms NOT NULL,
  active_count integer NOT NULL DEFAULT 0 CHECK (active_count >= 0),
  recovered_count integer NOT NULL DEFAULT 0 CHECK (recovered_count >= 0),
  last_seen_at timestamptz NOT NULL,
  PRIMARY KEY (bundle_id, bucket_start)
);

CREATE OR REPLACE FUNCTION public.increment_bundle_lifecycle_metric(
  p_bundle_id uuid,
  p_bucket_start timestamptz,
  p_channel text,
  p_platform public.platforms,
  p_active_delta integer,
  p_recovered_delta integer,
  p_observed_at timestamptz
) RETURNS void
LANGUAGE sql
AS $$
  INSERT INTO public.bundle_lifecycle_metrics AS metrics (
    bundle_id,
    bucket_start,
    channel,
    platform,
    active_count,
    recovered_count,
    last_seen_at
  ) VALUES (
    p_bundle_id,
    p_bucket_start,
    p_channel,
    p_platform,
    p_active_delta,
    p_recovered_delta,
    p_observed_at
  )
  ON CONFLICT (bundle_id, bucket_start) DO UPDATE SET
    active_count = metrics.active_count + EXCLUDED.active_count,
    recovered_count = metrics.recovered_count + EXCLUDED.recovered_count,
    channel = EXCLUDED.channel,
    platform = EXCLUDED.platform,
    last_seen_at = GREATEST(metrics.last_seen_at, EXCLUDED.last_seen_at);
$$;

ALTER TABLE public.telemetry_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bundle_lifecycle_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bundle_lifecycle_metrics ENABLE ROW LEVEL SECURITY;
