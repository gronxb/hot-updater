-- Migration number: 0004
-- Add signature column for cryptographic bundle verification
-- Stores RSA-SHA256 signature of the bundle fileHash
-- NULL for bundles created before code signing feature

-- Add signature column with NULL default for backward compatibility
ALTER TABLE bundles ADD COLUMN signature TEXT;

-- Index for signature verification queries
CREATE INDEX IF NOT EXISTS bundles_signature_idx ON bundles(signature);
