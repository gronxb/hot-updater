INSERT INTO
  private_hot_updater_settings (`key`, value)
VALUES
  ('schema.core', '0.37.0')
ON DUPLICATE KEY UPDATE
  value = '0.37.0';
