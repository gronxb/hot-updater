-- Migration number: 0003 	 2025-05-18T16:25:12.486Z
-- HotUpdater.bundles

ALTER TABLE bundles ADD COLUMN fingerprint_hash TEXT;
ALTER TABLE bundles ADD COLUMN storage_uri TEXT;

UPDATE bundles
SET storage_uri = 'supabase-storage://%%BUCKET_NAME%%/' || id || '/bundle.zip'
WHERE storage_uri IS NULL;

CREATE TABLE bundles_temp (
    id TEXT PRIMARY KEY,
    app_id TEXT NOT NULL,
    target_app_version TEXT,
    created_at TEXT NOT NULL,
    storage_uri TEXT NOT NULL,
    fingerprint_hash TEXT,
    FOREIGN KEY (app_id) REFERENCES apps(id)
);

INSERT INTO bundles_temp 
SELECT id, app_id, target_app_version, created_at, storage_uri, fingerprint_hash
FROM bundles;

DROP TABLE bundles;

ALTER TABLE bundles_temp RENAME TO bundles;

CREATE INDEX bundles_fingerprint_hash_idx ON bundles(fingerprint_hash);