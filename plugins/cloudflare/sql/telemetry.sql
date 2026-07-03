CREATE TABLE IF NOT EXISTS ingest_keys (
    id TEXT PRIMARY KEY CHECK (id = 'default'),
    key_hash TEXT NOT NULL CHECK (length(key_hash) = 64),
    key_suffix TEXT NOT NULL CHECK (length(key_suffix) = 8),
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS analytics_events (
    id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    payload TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    received_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS analytics_events_event_type_idx
    ON analytics_events(event_type);
CREATE INDEX IF NOT EXISTS analytics_events_observed_at_idx
    ON analytics_events(observed_at);
