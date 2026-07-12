CREATE TABLE IF NOT EXISTS channels (
  id varchar(255) PRIMARY KEY NOT NULL
);

ALTER TABLE bundles
ALTER COLUMN channel TYPE varchar(255);

INSERT INTO channels (id)
SELECT DISTINCT channel
FROM bundles;

ALTER TABLE bundles
ADD CONSTRAINT bundles_channel_fk FOREIGN KEY (channel) REFERENCES channels (id) ON UPDATE RESTRICT ON DELETE RESTRICT;

INSERT INTO
  private_hot_updater_settings (key, value)
VALUES
  ('version', '0.36.0')
ON CONFLICT (key) DO UPDATE
SET
  value = '0.36.0';
