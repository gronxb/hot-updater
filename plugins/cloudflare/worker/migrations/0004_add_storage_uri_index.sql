-- Migration number: 0004
-- HotUpdater.bundles

CREATE INDEX IF NOT EXISTS bundles_storage_uri_idx ON bundles(storage_uri);
