-- HotUpdater.bundles

ALTER TABLE bundles
  ADD COLUMN IF NOT EXISTS rollout_percentage INTEGER DEFAULT 100
    CHECK (rollout_percentage >= 0 AND rollout_percentage <= 100);

CREATE INDEX IF NOT EXISTS bundles_rollout_idx ON bundles(rollout_percentage);

ALTER TABLE bundles
  ADD COLUMN IF NOT EXISTS target_device_ids TEXT[];

CREATE INDEX IF NOT EXISTS bundles_target_device_ids_idx ON bundles
  USING GIN (target_device_ids);

-- HotUpdater.device_events

CREATE TABLE IF NOT EXISTS device_events (
  id uuid PRIMARY KEY,
  device_id TEXT NOT NULL,
  bundle_id uuid NOT NULL REFERENCES bundles(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN ('PROMOTED', 'RECOVERED')),
  platform platforms NOT NULL,
  app_version TEXT,
  channel TEXT NOT NULL,
  metadata JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS device_events_device_id_idx ON device_events(device_id);
CREATE INDEX IF NOT EXISTS device_events_bundle_id_idx ON device_events(bundle_id);
CREATE INDEX IF NOT EXISTS device_events_id_idx ON device_events(id DESC);

-- HotUpdater.get_rollout_stats

CREATE OR REPLACE FUNCTION get_rollout_stats(target_bundle_id uuid)
RETURNS TABLE (
  total_devices BIGINT,
  promoted_count BIGINT,
  recovered_count BIGINT,
  success_rate NUMERIC
) LANGUAGE SQL AS $$
  WITH latest AS (
    SELECT DISTINCT ON (device_id)
      device_id,
      event_type
    FROM device_events
    WHERE bundle_id = target_bundle_id
    ORDER BY device_id, id DESC
  )
  SELECT
    COUNT(*) as total_devices,
    COUNT(*) FILTER (WHERE event_type = 'PROMOTED') as promoted_count,
    COUNT(*) FILTER (WHERE event_type = 'RECOVERED') as recovered_count,
    CASE
      WHEN COUNT(*) > 0 THEN
        ROUND(
          (COUNT(*) FILTER (WHERE event_type = 'PROMOTED')::NUMERIC /
           COUNT(*)::NUMERIC) * 100,
          2
        )
      ELSE 0
    END as success_rate
  FROM latest;
$$;

