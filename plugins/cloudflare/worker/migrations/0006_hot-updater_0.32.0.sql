CREATE TABLE bundle_events (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    install_id TEXT NOT NULL,
    active_bundle_id TEXT NOT NULL,
    previous_active_bundle_id TEXT,
    crashed_bundle_id TEXT,
    platform TEXT NOT NULL CHECK (platform IN ('ios', 'android')),
    channel TEXT NOT NULL,
    app_version TEXT,
    fingerprint_hash TEXT,
    cohort TEXT,
    payload TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS bundle_events_install_id_idx
    ON bundle_events(install_id);
CREATE INDEX IF NOT EXISTS bundle_events_active_bundle_id_idx
    ON bundle_events(active_bundle_id);
CREATE INDEX IF NOT EXISTS bundle_events_platform_channel_idx
    ON bundle_events(platform, channel);
