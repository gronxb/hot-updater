-- HotUpdater.insights-1.0.1
-- Preserve existing reports while adding the fixed Insights query paths.
ALTER TABLE bundle_events ALTER COLUMN install_id TYPE text COLLATE "C";
ALTER TABLE bundle_events ALTER COLUMN user_id TYPE text COLLATE "C";
ALTER TABLE bundle_events ALTER COLUMN platform TYPE text COLLATE "C";
ALTER TABLE bundle_events ALTER COLUMN channel TYPE text COLLATE "C";
ALTER TABLE bundle_installations ALTER COLUMN install_id TYPE text COLLATE "C";
ALTER TABLE bundle_installations ALTER COLUMN user_id TYPE text COLLATE "C";
ALTER TABLE bundle_installations ALTER COLUMN platform TYPE text COLLATE "C";
ALTER TABLE bundle_installations ALTER COLUMN channel TYPE text COLLATE "C";
CREATE INDEX IF NOT EXISTS bundle_events_from_bundle_idx ON bundle_events(type, platform, channel, from_bundle_id, received_at_ms, id);
CREATE INDEX IF NOT EXISTS bundle_events_to_bundle_idx ON bundle_events(type, platform, channel, to_bundle_id, received_at_ms, id);
CREATE INDEX IF NOT EXISTS bundle_installations_scope_idx ON bundle_installations(platform, channel, received_at_ms);
CREATE INDEX IF NOT EXISTS bundle_installations_bundle_idx ON bundle_installations(platform, channel, to_bundle_id, received_at_ms);
INSERT INTO private_hot_updater_settings(key, value) VALUES ('schema.core', '1.0.1') ON CONFLICT (key) DO UPDATE SET value = excluded.value;
