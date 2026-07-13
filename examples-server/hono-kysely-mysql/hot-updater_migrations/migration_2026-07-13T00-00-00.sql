CREATE TABLE IF NOT EXISTS channels (
  id varchar(255) PRIMARY KEY NOT NULL,
  name varchar(255) NOT NULL
);

CREATE UNIQUE INDEX channels_name_key ON channels(name);

ALTER TABLE bundles ADD COLUMN channel_id varchar(255);

INSERT IGNORE INTO channels (id, name)
SELECT DISTINCT channel, channel
FROM bundles;

UPDATE bundles
JOIN channels ON channels.name = bundles.channel
SET bundles.channel_id = channels.id;

ALTER TABLE bundles
MODIFY COLUMN channel_id varchar(255) NOT NULL;

CREATE INDEX bundles_channel_id_idx ON bundles(channel_id);

ALTER TABLE bundles
ADD CONSTRAINT bundles_channel_id_fk FOREIGN KEY (channel_id) REFERENCES channels (id) ON UPDATE RESTRICT ON DELETE RESTRICT;

ALTER TABLE bundles DROP COLUMN channel;

INSERT INTO
  private_hot_updater_settings (`key`, value)
VALUES
  ('version', '0.36.0')
ON DUPLICATE KEY UPDATE
  value = '0.36.0';
