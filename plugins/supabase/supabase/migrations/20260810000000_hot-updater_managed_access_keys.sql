-- hot-updater-managed-access-keys
CREATE TABLE IF NOT EXISTS public.managed_access_keys (
  id text PRIMARY KEY,
  hash text NOT NULL UNIQUE,
  name text NOT NULL,
  prefix text NOT NULL,
  role text NOT NULL CHECK (role = 'client'),
  enabled boolean NOT NULL DEFAULT true,
  created_at_ms bigint NOT NULL,
  revoked_at_ms bigint,
  CONSTRAINT managed_access_keys_enabled_revoked_check CHECK (
    (enabled AND revoked_at_ms IS NULL) OR
    (NOT enabled AND revoked_at_ms IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS managed_access_keys_created_at_idx
  ON public.managed_access_keys (created_at_ms DESC, id ASC);

ALTER TABLE public.managed_access_keys ENABLE ROW LEVEL SECURITY;
