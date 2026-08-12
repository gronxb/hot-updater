-- HotUpdater.channels_0_38_0

CREATE TABLE IF NOT EXISTS channels (
    id text PRIMARY KEY,
    name text NOT NULL
);

ALTER TABLE bundles ADD COLUMN IF NOT EXISTS channel_id text;

INSERT INTO channels (id, name)
SELECT gen_random_uuid()::text, legacy.channel
FROM (
    SELECT DISTINCT channel
    FROM bundles
) AS legacy
WHERE NOT EXISTS (
    SELECT 1
    FROM channels
    WHERE channels.name = legacy.channel
);

UPDATE bundles
SET channel_id = channels.id
FROM channels
WHERE bundles.channel = channels.name
  AND bundles.channel_id IS NULL;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM bundles
        LEFT JOIN channels
          ON channels.id = bundles.channel_id
         AND channels.name = bundles.channel
        WHERE channels.id IS NULL
    ) THEN
        RAISE EXCEPTION 'Hot Updater channel backfill is incomplete';
    END IF;
END
$$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'channels_name_unique'
          AND conrelid = 'channels'::regclass
    ) THEN
        ALTER TABLE channels
        ADD CONSTRAINT channels_name_unique UNIQUE (name);
    END IF;
END
$$;

ALTER TABLE bundles ALTER COLUMN channel_id SET NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'bundles_channel_reference'
          AND conrelid = 'bundles'::regclass
    ) THEN
        ALTER TABLE bundles
        ADD CONSTRAINT bundles_channel_reference
        FOREIGN KEY (channel_id)
        REFERENCES channels(id);
    END IF;
END
$$;

CREATE INDEX IF NOT EXISTS bundles_channel_id_idx ON bundles(channel_id);
