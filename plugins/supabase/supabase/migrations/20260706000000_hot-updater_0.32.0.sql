CREATE TABLE IF NOT EXISTS bundle_events (
    id uuid PRIMARY KEY,
    kind text NOT NULL,
    install_id text NOT NULL,
    active_bundle_id uuid NOT NULL,
    previous_active_bundle_id uuid,
    crashed_bundle_id uuid,
    platform platforms NOT NULL,
    channel text NOT NULL,
    app_version text,
    fingerprint_hash text,
    cohort text,
    payload jsonb NOT NULL
);

CREATE INDEX IF NOT EXISTS bundle_events_install_id_idx
    ON bundle_events(install_id);
CREATE INDEX IF NOT EXISTS bundle_events_active_bundle_id_idx
    ON bundle_events(active_bundle_id);
CREATE INDEX IF NOT EXISTS bundle_events_platform_channel_idx
    ON bundle_events(platform, channel);

ALTER TABLE public.bundle_events ENABLE ROW LEVEL SECURITY;
