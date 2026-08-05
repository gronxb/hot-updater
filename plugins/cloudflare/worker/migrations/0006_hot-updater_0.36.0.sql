CREATE TABLE IF NOT EXISTS private_hot_updater_settings (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);

INSERT INTO private_hot_updater_settings (key, value)
VALUES ('schema.core', '0.36.0')
ON CONFLICT(key) DO UPDATE SET value = CASE
  WHEN private_hot_updater_settings.value = excluded.value
    THEN private_hot_updater_settings.value
  ELSE NULL
END;
