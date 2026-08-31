-- HotUpdater Insights private layout v2.
-- Apply only while old event writers are drained. The trigger below fences them
-- immediately; bounded preparation must complete before v2 writers start.

ALTER TABLE bundle_events ADD COLUMN insights_write_version INTEGER;
ALTER TABLE bundle_events ADD COLUMN insights_install_key TEXT COLLATE BINARY;
ALTER TABLE bundle_events ADD COLUMN insights_row_bytes INTEGER;

CREATE TABLE private_hot_updater_insights_source_state (
  id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
  version INTEGER NOT NULL CHECK (version = 2),
  source_id TEXT COLLATE BINARY NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('preparing', 'ready', 'failed')),
  generation INTEGER NOT NULL CHECK (
    generation >= 0 AND generation <= 9007199254740991
  ),
  backfill_upper_received_at_ms REAL,
  backfill_upper_id TEXT COLLATE BINARY,
  backfill_after_received_at_ms REAL,
  backfill_after_id TEXT COLLATE BINARY
);

CREATE TABLE private_hot_updater_insights_source_events (
  generation INTEGER PRIMARY KEY NOT NULL,
  event_id TEXT COLLATE BINARY UNIQUE NOT NULL,
  received_at_ms REAL NOT NULL,
  row_bytes INTEGER NOT NULL,
  CONSTRAINT insights_source_generation_check CHECK (generation >= 1),
  CONSTRAINT insights_source_event_fk FOREIGN KEY (event_id)
    REFERENCES bundle_events(id) ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE TABLE private_hot_updater_insights_installation_events (
  install_id TEXT COLLATE BINARY NOT NULL,
  received_at_ms REAL NOT NULL,
  event_id TEXT COLLATE BINARY PRIMARY KEY NOT NULL,
  row_bytes INTEGER NOT NULL,
  CONSTRAINT insights_installation_event_fk FOREIGN KEY (event_id)
    REFERENCES bundle_events(id) ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE TABLE private_hot_updater_insights_bundle_events (
  bundle_id TEXT COLLATE BINARY NOT NULL,
  received_at_ms REAL NOT NULL,
  event_id TEXT COLLATE BINARY PRIMARY KEY NOT NULL,
  row_bytes INTEGER NOT NULL,
  CONSTRAINT insights_bundle_event_fk FOREIGN KEY (event_id)
    REFERENCES bundle_events(id) ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE TABLE private_hot_updater_insights_live_installations (
  install_key TEXT COLLATE BINARY PRIMARY KEY NOT NULL,
  install_id TEXT NOT NULL,
  event_id TEXT COLLATE BINARY NOT NULL,
  received_at_ms REAL NOT NULL,
  row_bytes INTEGER NOT NULL,
  CONSTRAINT insights_live_install_key_check CHECK (
    length(install_key) = 64
    AND install_key NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT insights_live_event_fk FOREIGN KEY (event_id)
    REFERENCES bundle_events(id) ON UPDATE RESTRICT ON DELETE RESTRICT
);

INSERT INTO private_hot_updater_insights_source_state (
  id, version, source_id, status, generation,
  backfill_upper_received_at_ms, backfill_upper_id
)
SELECT
  1,
  2,
  lower(hex(randomblob(16))),
  'preparing',
  0,
  (
    SELECT received_at_ms FROM bundle_events
    ORDER BY received_at_ms DESC, id COLLATE BINARY DESC LIMIT 1
  ),
  (
    SELECT id FROM bundle_events
    ORDER BY received_at_ms DESC, id COLLATE BINARY DESC LIMIT 1
  );

CREATE TRIGGER bundle_events_insights_writer_fence
BEFORE INSERT ON bundle_events
WHEN NEW.insights_write_version IS NOT 2
  OR length(NEW.insights_install_key) <> 64
  OR NEW.insights_install_key GLOB '*[^0-9a-f]*'
  OR NEW.insights_row_bytes IS NULL
  OR NEW.insights_row_bytes < 1
  OR NEW.insights_row_bytes > 2000000
  OR NOT EXISTS (
    SELECT 1 FROM private_hot_updater_insights_source_state
    WHERE id = 1 AND generation < 9007199254740991
  )
  OR NOT EXISTS (
    SELECT 1 FROM private_hot_updater_insights_source_state
    WHERE id = 1 AND version = 2 AND status = 'ready'
  )
BEGIN
  SELECT RAISE(ABORT, 'HOT_UPDATER_INSIGHTS_V2_NOT_READY');
END;

CREATE TRIGGER insights_live_install_key_collision
BEFORE INSERT ON private_hot_updater_insights_live_installations
WHEN EXISTS (
  SELECT 1 FROM private_hot_updater_insights_live_installations
  WHERE install_key = NEW.install_key AND install_id <> NEW.install_id
)
BEGIN
  SELECT RAISE(ABORT, 'HOT_UPDATER_INSIGHTS_INSTALL_KEY_COLLISION');
END;

CREATE TRIGGER bundle_events_insights_projection
AFTER INSERT ON bundle_events
BEGIN
  UPDATE private_hot_updater_insights_source_state
  SET generation = generation + 1
  WHERE id = 1 AND version = 2 AND status = 'ready'
    AND generation < 9007199254740991;

  INSERT INTO private_hot_updater_insights_source_events (
    generation, event_id, received_at_ms, row_bytes
  )
  SELECT generation, NEW.id, NEW.received_at_ms, NEW.insights_row_bytes
  FROM private_hot_updater_insights_source_state
  WHERE id = 1 AND version = 2 AND status = 'ready';

  INSERT INTO private_hot_updater_insights_installation_events (
    install_id, received_at_ms, event_id, row_bytes
  )
  SELECT NEW.install_id, NEW.received_at_ms, NEW.id, NEW.insights_row_bytes
  WHERE NEW.type IN ('UPDATE_APPLIED', 'RECOVERED');

  INSERT INTO private_hot_updater_insights_bundle_events (
    bundle_id, received_at_ms, event_id, row_bytes
  )
  SELECT CASE NEW.type
      WHEN 'UPDATE_APPLIED' THEN NEW.to_bundle_id
      WHEN 'RECOVERED' THEN NEW.from_bundle_id
    END,
    NEW.received_at_ms, NEW.id, NEW.insights_row_bytes
  WHERE NEW.type IN ('UPDATE_APPLIED', 'RECOVERED');

  INSERT INTO private_hot_updater_insights_live_installations (
    install_key, install_id, event_id, received_at_ms, row_bytes
  ) VALUES (
    NEW.insights_install_key, NEW.install_id, NEW.id, NEW.received_at_ms,
    NEW.insights_row_bytes
  )
  ON CONFLICT(install_key) DO UPDATE SET
    event_id = excluded.event_id,
    received_at_ms = excluded.received_at_ms,
    row_bytes = excluded.row_bytes
  WHERE private_hot_updater_insights_live_installations.install_id
      = excluded.install_id
    AND (
      private_hot_updater_insights_live_installations.received_at_ms
        < excluded.received_at_ms
      OR (
        private_hot_updater_insights_live_installations.received_at_ms
          = excluded.received_at_ms
        AND private_hot_updater_insights_live_installations.event_id
          < excluded.event_id
      )
    );
END;

CREATE INDEX private_hot_updater_insights_source_event_order_idx
  ON private_hot_updater_insights_source_events(received_at_ms, event_id);
CREATE INDEX private_hot_updater_insights_installation_event_order_idx
  ON private_hot_updater_insights_installation_events(
    install_id, received_at_ms, event_id
  );
CREATE INDEX private_hot_updater_insights_bundle_event_order_idx
  ON private_hot_updater_insights_bundle_events(
    bundle_id, received_at_ms, event_id
  );
