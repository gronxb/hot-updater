-- HotUpdater schema 1.0.1: fixed Insights access paths
CREATE INDEX IF NOT EXISTS bundle_events_from_bundle_idx ON bundle_events(type, platform, channel, from_bundle_id, received_at_ms, id);
CREATE INDEX IF NOT EXISTS bundle_events_to_bundle_idx ON bundle_events(type, platform, channel, to_bundle_id, received_at_ms, id);
CREATE INDEX IF NOT EXISTS bundle_installations_scope_idx ON bundle_installations(platform, channel, received_at_ms);
CREATE INDEX IF NOT EXISTS bundle_installations_bundle_idx ON bundle_installations(platform, channel, to_bundle_id, received_at_ms);
INSERT INTO private_hot_updater_settings(key, value) VALUES ('schema.core', '1.0.1') ON CONFLICT (key) DO UPDATE SET value = excluded.value;
