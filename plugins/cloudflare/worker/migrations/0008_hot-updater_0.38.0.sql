-- HotUpdater.channels
--
-- D1/SQLite cannot add a populated REFERENCES column as NOT NULL without
-- rebuilding bundles. Rebuilding would drop user-owned triggers attached to
-- bundles, so this migration keeps the literal foreign key and enforces the
-- non-null and channel/name invariants with BEFORE triggers.

CREATE TABLE channels (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL UNIQUE
);

INSERT INTO channels (id, name)
SELECT lower(hex(randomblob(16))), channel
FROM bundles
GROUP BY channel;

ALTER TABLE bundles
ADD COLUMN channel_id TEXT REFERENCES channels(id);

UPDATE bundles
SET channel_id = (
  SELECT channels.id
  FROM channels
  WHERE channels.name = bundles.channel
);

CREATE TABLE private_hot_updater_channel_backfill_check (
  invalid_count INTEGER NOT NULL CHECK (invalid_count = 0)
);

INSERT INTO private_hot_updater_channel_backfill_check (invalid_count)
SELECT count(*)
FROM bundles
LEFT JOIN channels ON channels.id = bundles.channel_id
WHERE bundles.channel_id IS NULL
  OR channels.name IS NULL
  OR channels.name <> bundles.channel;

DROP TABLE private_hot_updater_channel_backfill_check;

CREATE INDEX bundles_channel_id_idx ON bundles(channel_id);

CREATE TRIGGER bundles_channel_insert_guard
BEFORE INSERT ON bundles
WHEN NEW.channel_id IS NULL OR NOT EXISTS (
  SELECT 1
  FROM channels
  WHERE channels.id = NEW.channel_id
    AND channels.name = NEW.channel
)
BEGIN
  SELECT RAISE(ABORT, 'bundles channel and channel_id must match');
END;

CREATE TRIGGER bundles_channel_update_guard
BEFORE UPDATE OF channel, channel_id ON bundles
WHEN NEW.channel_id IS NULL OR NOT EXISTS (
  SELECT 1
  FROM channels
  WHERE channels.id = NEW.channel_id
    AND channels.name = NEW.channel
)
BEGIN
  SELECT RAISE(ABORT, 'bundles channel and channel_id must match');
END;

CREATE TRIGGER channels_name_update_guard
BEFORE UPDATE OF name ON channels
WHEN EXISTS (
  SELECT 1
  FROM bundles
  WHERE bundles.channel_id = OLD.id
    AND bundles.channel <> NEW.name
)
BEGIN
  SELECT RAISE(ABORT, 'channel name is referenced by bundles');
END;

INSERT INTO private_hot_updater_settings (key, value)
VALUES ('schema.core', '0.38.0')
ON CONFLICT(key) DO UPDATE SET value = CASE
  WHEN private_hot_updater_settings.value IN ('0.37.0', '0.38.0')
    THEN excluded.value
  ELSE NULL
END;
