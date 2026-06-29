CREATE TABLE IF NOT EXISTS telemetry_keys (
    id TEXT PRIMARY KEY CHECK (id = 'default'),
    key_hash TEXT NOT NULL CHECK (length(key_hash) = 64),
    key_suffix TEXT NOT NULL CHECK (length(key_suffix) = 8),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bundle_lifecycle_events (
    id TEXT PRIMARY KEY,
    bundle_id TEXT NOT NULL,
    install_id TEXT NOT NULL,
    event_type TEXT NOT NULL CHECK (event_type IN ('active', 'recovered')),
    platform TEXT NOT NULL CHECK (platform IN ('ios', 'android')),
    channel TEXT NOT NULL,
    crashed_bundle_id TEXT,
    observed_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    dedupe_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS bundle_install_state (
    install_id TEXT PRIMARY KEY,
    bundle_id TEXT NOT NULL,
    platform TEXT NOT NULL CHECK (platform IN ('ios', 'android')),
    channel TEXT NOT NULL,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    recovered_count INTEGER NOT NULL DEFAULT 0,
    last_event_id TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS bundle_lifecycle_events_observed_idx
    ON bundle_lifecycle_events(observed_at);
CREATE INDEX IF NOT EXISTS bundle_lifecycle_events_crashed_bundle_idx
    ON bundle_lifecycle_events(crashed_bundle_id);
CREATE INDEX IF NOT EXISTS bundle_install_state_bundle_idx
    ON bundle_install_state(bundle_id);
