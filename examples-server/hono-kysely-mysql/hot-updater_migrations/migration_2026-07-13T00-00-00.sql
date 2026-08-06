INSERT INTO
  private_hot_updater_settings (`key`, value)
VALUES
  ('schema.core', '0.36.0')
ON DUPLICATE KEY UPDATE
  value = '0.36.0';
