CREATE TABLE managed_access_keys (
  id TEXT PRIMARY KEY NOT NULL,
  hash TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role = 'client'),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at_ms INTEGER NOT NULL,
  revoked_at_ms INTEGER,
  CHECK (
    (enabled = 1 AND revoked_at_ms IS NULL)
    OR (enabled = 0 AND revoked_at_ms IS NOT NULL)
  )
);

CREATE INDEX managed_access_keys_created_idx
  ON managed_access_keys(created_at_ms DESC, id ASC);
