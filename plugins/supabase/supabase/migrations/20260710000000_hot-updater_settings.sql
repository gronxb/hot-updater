CREATE TABLE IF NOT EXISTS private_hot_updater_settings (
    key varchar(255) PRIMARY KEY,
    value text NOT NULL DEFAULT '0.32.0'
);

INSERT INTO private_hot_updater_settings (key, value)
VALUES ('version', '0.32.0')
ON CONFLICT (key) DO UPDATE SET value = '0.32.0';
