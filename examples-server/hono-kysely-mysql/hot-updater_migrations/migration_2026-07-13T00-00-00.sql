CREATE TABLE IF NOT EXISTS channels (
  id varchar(255) PRIMARY KEY NOT NULL
);

ALTER TABLE bundles
MODIFY COLUMN channel varchar(255) NOT NULL DEFAULT 'production';

INSERT INTO channels (id)
SELECT DISTINCT channel
FROM bundles;

ALTER TABLE bundles
ADD CONSTRAINT bundles_channel_fk FOREIGN KEY (channel) REFERENCES channels (id) ON UPDATE RESTRICT ON DELETE RESTRICT;

INSERT INTO
  private_hot_updater_settings (`key`, value)
VALUES
  ('version', '0.36.0')
ON DUPLICATE KEY UPDATE
  value = '0.36.0';
