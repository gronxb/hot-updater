-- Add signature column for cryptographic bundle verification
-- Stores RSA-SHA256 signature of the bundle fileHash
-- NULL for bundles created before code signing feature
-- Manual Migration: Users must run this file manually

BEGIN;

-- Add signature column with NULL default for backward compatibility
ALTER TABLE bundles
ADD COLUMN IF NOT EXISTS signature TEXT;

-- Index for signature verification queries
CREATE INDEX IF NOT EXISTS bundles_signature_idx ON bundles(signature);

-- Add comment explaining the field
COMMENT ON COLUMN bundles.signature IS 'RSA-SHA256 signature of bundle fileHash (Base64-encoded). Optional field for cryptographic verification.';

COMMIT;
