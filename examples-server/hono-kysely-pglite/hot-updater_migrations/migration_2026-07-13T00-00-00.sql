INSERT INTO
  private_hot_updater_settings (key, value)
VALUES
  ('schema.core', '0.36.0')
ON CONFLICT (key) DO UPDATE
SET
  value = '0.36.0';
