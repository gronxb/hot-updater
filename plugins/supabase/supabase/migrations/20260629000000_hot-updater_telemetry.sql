CREATE TABLE IF NOT EXISTS public.ingest_keys (
  id text PRIMARY KEY DEFAULT 'default',
  key_hash text NOT NULL,
  key_suffix text NOT NULL CHECK (char_length(key_suffix) = 8),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ingest_keys_singleton CHECK (id = 'default')
);

CREATE TABLE IF NOT EXISTS public.analytics_events (
  id text PRIMARY KEY,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  observed_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS analytics_events_event_type_idx
  ON public.analytics_events(event_type);

CREATE INDEX IF NOT EXISTS analytics_events_observed_at_idx
  ON public.analytics_events(observed_at);

ALTER TABLE public.ingest_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analytics_events ENABLE ROW LEVEL SECURITY;
