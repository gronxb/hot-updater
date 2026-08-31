-- Explicit online index preparation. Execute each statement outside a transaction.
-- Keep the existing three-key width. Activity events do not enter these indexes.
CREATE INDEX CONCURRENTLY bundle_events_install_applied_idx
  ON bundle_events (install_id, received_at_ms, id)
  WHERE type = 'UPDATE_APPLIED';
CREATE INDEX CONCURRENTLY bundle_events_install_recovered_idx
  ON bundle_events (install_id, received_at_ms, id)
  WHERE type = 'RECOVERED';
