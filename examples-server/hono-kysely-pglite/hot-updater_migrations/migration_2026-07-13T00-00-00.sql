CREATE TABLE IF NOT EXISTS channels (
  id varchar(255) PRIMARY KEY NOT NULL,
  name varchar(255) NOT NULL
);

CREATE UNIQUE INDEX channels_name_key ON channels(name);

ALTER TABLE bundles ADD COLUMN channel_id varchar(255);

INSERT INTO channels (id, name)
SELECT DISTINCT channel, channel
FROM bundles;

UPDATE bundles
SET channel_id = channels.id
FROM channels
WHERE channels.name = bundles.channel;

ALTER TABLE bundles ALTER COLUMN channel_id SET NOT NULL;

CREATE INDEX bundles_channel_id_idx ON bundles(channel_id);

ALTER TABLE bundles
ADD CONSTRAINT bundles_channel_id_fk FOREIGN KEY (channel_id) REFERENCES channels (id) ON UPDATE RESTRICT ON DELETE RESTRICT;

INSERT INTO
  private_hot_updater_settings (key, value)
VALUES
  ('version', '0.36.0')
ON CONFLICT (key) DO UPDATE
SET
  value = '0.36.0';
