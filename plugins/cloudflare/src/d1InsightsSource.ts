import {
  DatabasePluginInputError,
  InsightsQueryNotReadyError,
  type BundleEventRow,
} from "@hot-updater/plugin-core";
import {
  INSIGHTS_EVENT_MAX_BYTES,
  INSIGHTS_PAGE_MAX_BYTES,
  INSIGHTS_PAGE_MAX_ROWS,
  assertInsightsEventContract,
  assertInsightsEventRow,
  canonicalInsightsJson,
  databaseFields,
  getCanonicalInsightsJsonByteLength,
  getInsightsInstallationOrderKey,
  isCanonicalInsightsEventId,
} from "@hot-updater/plugin-core/internal";

import type { D1Executor, D1Statement } from "./d1Implementation";
import { d1Placeholders, encodeD1Values, normalizeD1SchemaSql } from "./d1Sql";

const SOURCE_STATE = "private_hot_updater_insights_source_state";
const SOURCE_EVENTS = "private_hot_updater_insights_source_events";
const PENDING_EVENTS = "private_hot_updater_insights_pending_events";
const LIVE_INSTALLATIONS = "private_hot_updater_insights_live_installations";
export const D1_INSIGHTS_INSTALLATION_ALIASES =
  "private_hot_updater_insights_installation_aliases";
export const D1_INSIGHTS_INSTALLATION_VERSIONS =
  "private_hot_updater_insights_installation_versions";
const SOURCE_ID = /^[0-9a-f]{32}$/;
const INSTALL_KEY = /^[0-9a-f]{64}$/;
const MAX_BACKFILL_PAGE = 100;
const MAX_BACKFILL_PAYLOAD_BYTES = 500_000;
const MAX_SAFE_GENERATION = Number.MAX_SAFE_INTEGER;
const INSTALL_KEY_COLLISION_MARKER =
  "HOT_UPDATER_INSIGHTS_INSTALL_KEY_COLLISION";
const textEncoder = new TextEncoder();

const WRITER_TRIGGER_SQL = `CREATE TRIGGER bundle_events_insights_writer_fence
BEFORE INSERT ON bundle_events
WHEN NEW.insights_write_version IS NOT 2
  OR length(NEW.id) <> 36
  OR substr(NEW.id, 9, 1) <> '-'
  OR substr(NEW.id, 14, 1) <> '-'
  OR substr(NEW.id, 15, 1) <> '7'
  OR substr(NEW.id, 19, 1) <> '-'
  OR substr(NEW.id, 20, 1) NOT IN ('8', '9', 'a', 'b')
  OR substr(NEW.id, 24, 1) <> '-'
  OR length(replace(NEW.id, '-', '')) <> 32
  OR replace(NEW.id, '-', '') GLOB '*[^0-9a-f]*'
  OR length(NEW.insights_install_key) <> 64
  OR NEW.insights_install_key GLOB '*[^0-9a-f]*'
  OR NEW.insights_row_bytes IS NULL
  OR NEW.insights_row_bytes < 1
  OR NEW.insights_row_bytes > ${INSIGHTS_EVENT_MAX_BYTES}
  OR NEW.insights_event_json IS NULL
  OR NOT json_valid(NEW.insights_event_json)
  OR length(CAST(NEW.insights_event_json AS BLOB)) <> NEW.insights_row_bytes
  OR NEW.insights_aliases_json IS NULL
  OR NOT json_valid(NEW.insights_aliases_json)
  OR NOT EXISTS (
    SELECT 1 FROM private_hot_updater_insights_source_state
    WHERE id = 1 AND generation < 9007199254740991
  )
  OR NOT EXISTS (
    SELECT 1 FROM private_hot_updater_insights_source_state
    WHERE id = 1 AND version = 2 AND status IN ('preparing', 'ready')
  )
BEGIN
  SELECT RAISE(ABORT, 'HOT_UPDATER_INSIGHTS_V2_NOT_READY');
END`;

const COLLISION_TRIGGER_SQL = `CREATE TRIGGER insights_live_install_key_collision
BEFORE INSERT ON private_hot_updater_insights_live_installations
WHEN EXISTS (
  SELECT 1 FROM private_hot_updater_insights_live_installations
  WHERE install_key = NEW.install_key AND install_id <> NEW.install_id
)
BEGIN
  SELECT RAISE(ABORT, 'HOT_UPDATER_INSIGHTS_INSTALL_KEY_COLLISION');
END`;

const ALIAS_COLLISION_TRIGGER_SQL = `CREATE TRIGGER insights_alias_install_key_collision
BEFORE INSERT ON private_hot_updater_insights_installation_aliases
WHEN EXISTS (
  SELECT 1 FROM private_hot_updater_insights_installation_aliases
  WHERE install_key = NEW.install_key AND install_id <> NEW.install_id
)
BEGIN
  SELECT RAISE(ABORT, 'HOT_UPDATER_INSIGHTS_INSTALL_KEY_COLLISION');
END`;

const SOURCE_EVENTS_TABLE_SQL = `CREATE TABLE private_hot_updater_insights_source_events (
  generation INTEGER PRIMARY KEY NOT NULL,
  event_id TEXT COLLATE BINARY UNIQUE NOT NULL,
  received_at_ms REAL NOT NULL,
  row_bytes INTEGER NOT NULL,
  event_json TEXT NOT NULL,
  CONSTRAINT insights_source_generation_check CHECK (generation >= 1),
  CONSTRAINT insights_source_event_fk FOREIGN KEY (event_id)
    REFERENCES bundle_events(id) ON UPDATE RESTRICT ON DELETE RESTRICT
)`;

const SOURCE_STATE_TABLE_SQL = `CREATE TABLE private_hot_updater_insights_source_state (
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
)`;

const PENDING_EVENTS_TABLE_SQL = `CREATE TABLE private_hot_updater_insights_pending_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT COLLATE BINARY UNIQUE NOT NULL,
  received_at_ms REAL NOT NULL,
  row_bytes INTEGER NOT NULL,
  event_json TEXT NOT NULL,
  CONSTRAINT insights_pending_event_fk FOREIGN KEY (event_id)
    REFERENCES bundle_events(id) ON UPDATE RESTRICT ON DELETE RESTRICT
)`;

const INSTALLATION_EVENTS_TABLE_SQL = `CREATE TABLE private_hot_updater_insights_installation_events (
  install_id TEXT COLLATE BINARY NOT NULL,
  received_at_ms REAL NOT NULL,
  event_id TEXT COLLATE BINARY PRIMARY KEY NOT NULL,
  row_bytes INTEGER NOT NULL,
  CONSTRAINT insights_installation_event_fk FOREIGN KEY (event_id)
    REFERENCES bundle_events(id) ON UPDATE RESTRICT ON DELETE RESTRICT
)`;

const BUNDLE_EVENTS_TABLE_SQL = `CREATE TABLE private_hot_updater_insights_bundle_events (
  bundle_id TEXT COLLATE BINARY NOT NULL,
  received_at_ms REAL NOT NULL,
  event_id TEXT COLLATE BINARY PRIMARY KEY NOT NULL,
  row_bytes INTEGER NOT NULL,
  CONSTRAINT insights_bundle_event_fk FOREIGN KEY (event_id)
    REFERENCES bundle_events(id) ON UPDATE RESTRICT ON DELETE RESTRICT
)`;

const LIVE_INSTALLATIONS_TABLE_SQL = `CREATE TABLE private_hot_updater_insights_live_installations (
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
)`;

const INSTALLATION_ALIASES_TABLE_SQL = `CREATE TABLE private_hot_updater_insights_installation_aliases (
  alias_id INTEGER PRIMARY KEY NOT NULL,
  install_key TEXT COLLATE BINARY NOT NULL,
  install_id TEXT NOT NULL,
  alias_kind TEXT NOT NULL,
  alias_value TEXT COLLATE BINARY NOT NULL,
  folded_value TEXT COLLATE BINARY NOT NULL,
  first_generation INTEGER NOT NULL,
  CONSTRAINT insights_alias_key_check CHECK (
    length(install_key) = 64
    AND install_key NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT insights_alias_kind_check CHECK (
    alias_kind IN ('installId', 'userId', 'username')
  ),
  CONSTRAINT insights_alias_generation_check CHECK (first_generation >= 1),
  UNIQUE (install_key, alias_kind, alias_value)
)`;

const INSTALLATION_VERSIONS_TABLE_SQL = `CREATE TABLE private_hot_updater_insights_installation_versions (
  install_key TEXT COLLATE BINARY NOT NULL,
  generation INTEGER NOT NULL,
  install_id TEXT NOT NULL,
  event_id TEXT COLLATE BINARY NOT NULL,
  received_at_ms REAL NOT NULL,
  row_bytes INTEGER NOT NULL,
  PRIMARY KEY (install_key, generation),
  CONSTRAINT insights_version_key_check CHECK (
    length(install_key) = 64
    AND install_key NOT GLOB '*[^0-9a-f]*'
  ),
  CONSTRAINT insights_version_generation_check CHECK (generation >= 1),
  CONSTRAINT insights_version_event_fk FOREIGN KEY (event_id)
    REFERENCES bundle_events(id) ON UPDATE RESTRICT ON DELETE RESTRICT
)`;

const PROJECTION_TRIGGER_SQL = `CREATE TRIGGER bundle_events_insights_projection
AFTER INSERT ON bundle_events
BEGIN
  INSERT INTO private_hot_updater_insights_pending_events (
    event_id, received_at_ms, row_bytes, event_json
  )
  SELECT NEW.id, NEW.received_at_ms, NEW.insights_row_bytes,
    NEW.insights_event_json
  FROM private_hot_updater_insights_source_state
  WHERE id = 1 AND version = 2 AND status = 'preparing';

  UPDATE private_hot_updater_insights_source_state
  SET generation = generation + 1
  WHERE id = 1 AND version = 2 AND status = 'ready'
    AND generation < 9007199254740991;

  INSERT INTO private_hot_updater_insights_source_events (
    generation, event_id, received_at_ms, row_bytes, event_json
  )
  SELECT generation, NEW.id, NEW.received_at_ms, NEW.insights_row_bytes,
    NEW.insights_event_json
  FROM private_hot_updater_insights_source_state
  WHERE id = 1 AND version = 2 AND status = 'ready';

  INSERT OR IGNORE INTO private_hot_updater_insights_installation_aliases (
    install_key, install_id, alias_kind, alias_value, folded_value,
    first_generation
  )
  SELECT NEW.insights_install_key, NEW.install_id,
    json_extract(alias.value, '$.kind'),
    json_extract(alias.value, '$.value'),
    json_extract(alias.value, '$.folded'), source.generation
  FROM private_hot_updater_insights_source_state AS source,
    json_each(NEW.insights_aliases_json) AS alias
  WHERE source.id = 1 AND source.version = 2 AND source.status = 'ready';

  INSERT INTO private_hot_updater_insights_installation_events (
    install_id, received_at_ms, event_id, row_bytes
  )
  SELECT NEW.install_id, NEW.received_at_ms, NEW.id, NEW.insights_row_bytes
  WHERE NEW.type IN ('UPDATE_APPLIED', 'RECOVERED')
    AND EXISTS (
      SELECT 1 FROM private_hot_updater_insights_source_state
      WHERE id = 1 AND version = 2 AND status = 'ready'
    );

  INSERT INTO private_hot_updater_insights_bundle_events (
    bundle_id, received_at_ms, event_id, row_bytes
  )
  SELECT CASE NEW.type
      WHEN 'UPDATE_APPLIED' THEN NEW.to_bundle_id
      WHEN 'RECOVERED' THEN NEW.from_bundle_id
    END,
    NEW.received_at_ms, NEW.id, NEW.insights_row_bytes
  WHERE NEW.type IN ('UPDATE_APPLIED', 'RECOVERED')
    AND EXISTS (
      SELECT 1 FROM private_hot_updater_insights_source_state
      WHERE id = 1 AND version = 2 AND status = 'ready'
    );

  INSERT INTO private_hot_updater_insights_live_installations (
    install_key, install_id, event_id, received_at_ms, row_bytes
  )
  SELECT NEW.insights_install_key, NEW.install_id, NEW.id,
    NEW.received_at_ms, NEW.insights_row_bytes
  FROM private_hot_updater_insights_source_state
  WHERE id = 1 AND version = 2 AND status = 'ready'
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

  INSERT INTO private_hot_updater_insights_installation_versions (
    install_key, generation, install_id, event_id, received_at_ms, row_bytes
  )
  SELECT live.install_key, source.generation, live.install_id, live.event_id,
    live.received_at_ms, live.row_bytes
  FROM private_hot_updater_insights_source_state AS source
  JOIN private_hot_updater_insights_live_installations AS live
    ON live.install_key = NEW.insights_install_key
  WHERE source.id = 1 AND source.version = 2 AND source.status = 'ready';
END`;

const schemaSql = (value: unknown): string | null =>
  typeof value === "string" ? normalizeD1SchemaSql(value) : null;

const invalidQuery = (): never => {
  throw new DatabasePluginInputError("invalid-query");
};

const invalidResult = (): never => {
  throw new DatabasePluginInputError("invalid-result");
};

export class D1InsightsMigrationPoisonError extends Error {
  readonly name = "D1InsightsMigrationPoisonError";

  constructor(readonly sourceId: string) {
    super("D1 Insights source migration is poisoned");
  }
}

class D1InsightsInstallKeyCollisionError extends Error {
  readonly name = "D1InsightsInstallKeyCollisionError";
}

const isProvenCorruption = (error: unknown): boolean =>
  error instanceof DatabasePluginInputError && error.code === "invalid-result";

const isInstallKeyCollision = (error: unknown): boolean =>
  error instanceof D1InsightsInstallKeyCollisionError ||
  (error instanceof Error &&
    error.message.includes(INSTALL_KEY_COLLISION_MARKER));

const record = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const safeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const LEGACY_EVENT_BYTES_SQL = `length(CAST(json_object(
  'app_version', app_version,
  'channel', channel,
  'cohort', cohort,
  'fingerprint_hash', fingerprint_hash,
  'from_bundle_id', from_bundle_id,
  'from_release_id', from_release_id,
  'id', id,
  'install_id', install_id,
  'platform', platform,
  'received_at_ms', CAST(received_at_ms AS INTEGER),
  'sdk_version', sdk_version,
  'to_bundle_id', to_bundle_id,
  'to_release_id', to_release_id,
  'type', type,
  'update_strategy', update_strategy,
  'user_id', user_id,
  'username', username
) AS BLOB))`;

const eventBytes = (row: BundleEventRow): number => {
  assertInsightsEventRow(row);
  assertInsightsEventContract(row);
  return getCanonicalInsightsJsonByteLength(row);
};

const bytesToHex = (bytes: Uint8Array): string =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

export const d1InsightsInstallKey = async (
  installId: string,
): Promise<string> => {
  return bytesToHex(await getInsightsInstallationOrderKey(installId));
};

type D1InsightsAlias = {
  readonly kind: "installId" | "userId" | "username";
  readonly value: string;
  readonly folded: string;
};

const eventAliases = (row: BundleEventRow): readonly D1InsightsAlias[] => {
  const aliases: D1InsightsAlias[] = [
    {
      kind: "installId",
      value: row.install_id,
      folded: row.install_id.toLowerCase(),
    },
  ];
  if (row.user_id !== null) {
    aliases.push({
      kind: "userId",
      value: row.user_id,
      folded: row.user_id.toLowerCase(),
    });
  }
  if (row.username !== null) {
    aliases.push({
      kind: "username",
      value: row.username,
      folded: row.username.toLowerCase(),
    });
  }
  return aliases;
};

export const createD1InsightsEventInsert = async (
  row: BundleEventRow,
): Promise<D1Statement> => {
  const rowBytes = eventBytes(row);
  const eventJson = canonicalInsightsJson(row);
  const installKey = await d1InsightsInstallKey(row.install_id);
  const columns = [
    ...databaseFields.bundle_events,
    "insights_write_version",
    "insights_install_key",
    "insights_row_bytes",
    "insights_event_json",
    "insights_aliases_json",
  ];
  const values = [
    ...databaseFields.bundle_events.map((field) => row[field]),
    2,
    installKey,
    rowBytes,
    eventJson,
    canonicalInsightsJson(eventAliases(row)),
  ];
  return {
    sql: `INSERT INTO bundle_events (${columns.join(", ")}) VALUES (${d1Placeholders(values.length)})`,
    params: encodeD1Values(values),
  };
};

type SourceState = {
  readonly source_id: string;
  readonly status: string;
  readonly generation: number;
  readonly backfill_upper_received_at_ms: number | null;
  readonly backfill_upper_id: string | null;
  readonly backfill_after_received_at_ms: number | null;
  readonly backfill_after_id: string | null;
};

const sourceState = (value: unknown): SourceState => {
  if (!record(value)) return invalidResult();
  const sourceId = value.source_id;
  const status = value.status;
  const generation = value.generation;
  const upperTime = value.backfill_upper_received_at_ms;
  const upper = value.backfill_upper_id;
  const afterTime = value.backfill_after_received_at_ms;
  const after = value.backfill_after_id;
  if (typeof sourceId !== "string" || !SOURCE_ID.test(sourceId))
    return invalidResult();
  if (status !== "preparing" && status !== "ready" && status !== "failed")
    return invalidResult();
  if (!safeInteger(generation) || generation > MAX_SAFE_GENERATION)
    return invalidResult();
  if (upperTime !== null && !safeInteger(upperTime)) return invalidResult();
  if (upper !== null && typeof upper !== "string") return invalidResult();
  if (afterTime !== null && !safeInteger(afterTime)) return invalidResult();
  if (after !== null && typeof after !== "string") return invalidResult();
  if ((upperTime === null) !== (upper === null)) return invalidResult();
  if ((afterTime === null) !== (after === null)) return invalidResult();
  return {
    source_id: sourceId,
    status,
    generation,
    backfill_upper_received_at_ms: upperTime,
    backfill_upper_id: upper,
    backfill_after_received_at_ms: afterTime,
    backfill_after_id: after,
  };
};

const readState = async (executor: D1Executor): Promise<SourceState> => {
  const rows = await executor.query(
    `SELECT source_id, status, generation, backfill_upper_received_at_ms,
      backfill_upper_id, backfill_after_received_at_ms, backfill_after_id
      FROM ${SOURCE_STATE}
      WHERE id = 1 AND version = 2 LIMIT 1`,
    [],
  );
  if (rows.length !== 1) throw new InsightsQueryNotReadyError();
  return sourceState(rows[0]);
};

export const assertD1InsightsLayout = async (
  executor: D1Executor,
): Promise<void> => {
  const rows = await executor.query(
    `SELECT
      (SELECT group_concat(name || ':' || type || ':' || pk, ',') FROM (
        SELECT name, type, pk FROM pragma_table_info('bundle_events')
        WHERE name IN (
          'insights_write_version', 'insights_install_key', 'insights_row_bytes',
          'insights_event_json', 'insights_aliases_json'
        ) ORDER BY cid
      )) = 'insights_write_version:INTEGER:0,insights_install_key:TEXT:0,insights_row_bytes:INTEGER:0,insights_event_json:TEXT:0,insights_aliases_json:TEXT:0'
        AS raw_columns,
      (SELECT group_concat(name || ':' || type || ':' || "notnull" || ':' || pk, ',') FROM (
        SELECT name, type, "notnull", pk
        FROM pragma_table_info('${SOURCE_STATE}') ORDER BY cid
      )) = 'id:INTEGER:1:1,version:INTEGER:1:0,source_id:TEXT:1:0,status:TEXT:1:0,generation:INTEGER:1:0,backfill_upper_received_at_ms:REAL:0:0,backfill_upper_id:TEXT:0:0,backfill_after_received_at_ms:REAL:0:0,backfill_after_id:TEXT:0:0'
        AS state_columns,
      (SELECT sql FROM sqlite_master WHERE type = 'table'
        AND name = '${SOURCE_STATE}') AS state_table,
      (SELECT group_concat(name || ':' || type || ':' || "notnull" || ':' || pk, ',') FROM (
        SELECT name, type, "notnull", pk
        FROM pragma_table_info('${SOURCE_EVENTS}') ORDER BY cid
      )) = 'generation:INTEGER:1:1,event_id:TEXT:1:0,received_at_ms:REAL:1:0,row_bytes:INTEGER:1:0,event_json:TEXT:1:0'
        AS source_columns,
      (SELECT sql FROM sqlite_master WHERE type = 'table'
        AND name = '${SOURCE_EVENTS}') AS source_table,
      (SELECT group_concat(name || ':' || type || ':' || "notnull" || ':' || pk, ',') FROM (
        SELECT name, type, "notnull", pk
        FROM pragma_table_info('${PENDING_EVENTS}') ORDER BY cid
      )) = 'sequence:INTEGER:0:1,event_id:TEXT:1:0,received_at_ms:REAL:1:0,row_bytes:INTEGER:1:0,event_json:TEXT:1:0'
        AS pending_columns,
      (SELECT sql FROM sqlite_master WHERE type = 'table'
        AND name = '${PENDING_EVENTS}') AS pending_table,
      (SELECT group_concat(name || ':' || type || ':' || "notnull" || ':' || pk, ',') FROM (
        SELECT name, type, "notnull", pk
        FROM pragma_table_info('private_hot_updater_insights_installation_events')
        ORDER BY cid
      )) = 'install_id:TEXT:1:0,received_at_ms:REAL:1:0,event_id:TEXT:1:1,row_bytes:INTEGER:1:0'
        AS installation_columns,
      (SELECT sql FROM sqlite_master WHERE type = 'table'
        AND name = 'private_hot_updater_insights_installation_events')
        AS installation_table,
      (SELECT group_concat(name || ':' || type || ':' || "notnull" || ':' || pk, ',') FROM (
        SELECT name, type, "notnull", pk
        FROM pragma_table_info('private_hot_updater_insights_bundle_events')
        ORDER BY cid
      )) = 'bundle_id:TEXT:1:0,received_at_ms:REAL:1:0,event_id:TEXT:1:1,row_bytes:INTEGER:1:0'
        AS bundle_columns,
      (SELECT sql FROM sqlite_master WHERE type = 'table'
        AND name = 'private_hot_updater_insights_bundle_events')
        AS bundle_table,
      (SELECT group_concat(name || ':' || type || ':' || "notnull" || ':' || pk, ',') FROM (
        SELECT name, type, "notnull", pk
        FROM pragma_table_info('${LIVE_INSTALLATIONS}') ORDER BY cid
      )) = 'install_key:TEXT:1:1,install_id:TEXT:1:0,event_id:TEXT:1:0,received_at_ms:REAL:1:0,row_bytes:INTEGER:1:0'
        AS live_columns,
      (SELECT sql FROM sqlite_master WHERE type = 'table'
        AND name = '${LIVE_INSTALLATIONS}') AS live_table,
      (SELECT group_concat(name || ':' || type || ':' || "notnull" || ':' || pk, ',') FROM (
        SELECT name, type, "notnull", pk
        FROM pragma_table_info('${D1_INSIGHTS_INSTALLATION_ALIASES}') ORDER BY cid
      )) = 'alias_id:INTEGER:1:1,install_key:TEXT:1:0,install_id:TEXT:1:0,alias_kind:TEXT:1:0,alias_value:TEXT:1:0,folded_value:TEXT:1:0,first_generation:INTEGER:1:0'
        AS alias_columns,
      (SELECT sql FROM sqlite_master WHERE type = 'table'
        AND name = '${D1_INSIGHTS_INSTALLATION_ALIASES}') AS alias_table,
      (SELECT group_concat(name || ':' || type || ':' || "notnull" || ':' || pk, ',') FROM (
        SELECT name, type, "notnull", pk
        FROM pragma_table_info('${D1_INSIGHTS_INSTALLATION_VERSIONS}') ORDER BY cid
      )) = 'install_key:TEXT:1:1,generation:INTEGER:1:2,install_id:TEXT:1:0,event_id:TEXT:1:0,received_at_ms:REAL:1:0,row_bytes:INTEGER:1:0'
        AS version_columns,
      (SELECT sql FROM sqlite_master WHERE type = 'table'
        AND name = '${D1_INSIGHTS_INSTALLATION_VERSIONS}') AS version_table,
      (SELECT count(*) FROM pragma_table_info('bundle_events')
        WHERE name = 'id' AND type = 'TEXT' AND "notnull" = 1 AND pk = 1) = 1
        AS raw_id_column,
      (SELECT count(*) FROM pragma_index_list('bundle_events')
        WHERE name = 'sqlite_autoindex_bundle_events_1' AND "unique" = 1
          AND origin = 'pk' AND partial = 0) = 1 AS raw_id_index_decl,
      (SELECT group_concat(name || ':' || coll || ':' || desc, ',') FROM (
        SELECT name, coll, desc FROM pragma_index_xinfo('sqlite_autoindex_bundle_events_1')
        WHERE key = 1 ORDER BY seqno
      )) = 'id:BINARY:0' AS raw_id_index,
      (SELECT count(*) FROM pragma_index_list('bundle_events')
        WHERE name = 'bundle_events_received_at_idx' AND "unique" = 0
          AND origin = 'c' AND partial = 0) = 1 AS raw_index_decl,
      (SELECT group_concat(name || ':' || coll || ':' || desc, ',') FROM (
        SELECT name, coll, desc FROM pragma_index_xinfo('bundle_events_received_at_idx')
        WHERE key = 1 ORDER BY seqno
      )) = 'received_at_ms:BINARY:0,id:BINARY:0' AS raw_index,
      (SELECT count(*) FROM pragma_index_list('bundle_events')
        WHERE name = 'bundle_events_insights_backfill_idx' AND "unique" = 0
          AND origin = 'c' AND partial = 0) = 1 AS raw_backfill_index_decl,
      (SELECT group_concat(name || ':' || coll || ':' || desc, ',') FROM (
        SELECT name, coll, desc FROM pragma_index_xinfo('bundle_events_insights_backfill_idx')
        WHERE key = 1 ORDER BY seqno
      )) = 'insights_write_version:BINARY:0,received_at_ms:BINARY:0,id:BINARY:0'
        AS raw_backfill_index,
      (SELECT count(*) FROM pragma_index_list('${SOURCE_EVENTS}')
        WHERE name = 'private_hot_updater_insights_source_event_order_idx'
          AND "unique" = 0 AND origin = 'c' AND partial = 0) = 1
        AS source_index_decl,
      (SELECT group_concat(name || ':' || coll || ':' || desc, ',') FROM (
        SELECT name, coll, desc FROM pragma_index_xinfo('private_hot_updater_insights_source_event_order_idx')
        WHERE key = 1 ORDER BY seqno
      )) = 'received_at_ms:BINARY:0,event_id:BINARY:0' AS source_index,
      (SELECT count(*) FROM pragma_index_list('private_hot_updater_insights_installation_events')
        WHERE name = 'private_hot_updater_insights_installation_event_order_idx'
          AND "unique" = 0 AND origin = 'c' AND partial = 0) = 1
        AS installation_index_decl,
      (SELECT group_concat(name || ':' || coll || ':' || desc, ',') FROM (
        SELECT name, coll, desc FROM pragma_index_xinfo('private_hot_updater_insights_installation_event_order_idx')
        WHERE key = 1 ORDER BY seqno
      )) = 'install_id:BINARY:0,received_at_ms:BINARY:0,event_id:BINARY:0'
        AS installation_index,
      (SELECT count(*) FROM pragma_index_list('private_hot_updater_insights_bundle_events')
        WHERE name = 'private_hot_updater_insights_bundle_event_order_idx'
          AND "unique" = 0 AND origin = 'c' AND partial = 0) = 1
        AS bundle_index_decl,
      (SELECT group_concat(name || ':' || coll || ':' || desc, ',') FROM (
        SELECT name, coll, desc FROM pragma_index_xinfo('private_hot_updater_insights_bundle_event_order_idx')
        WHERE key = 1 ORDER BY seqno
      )) = 'bundle_id:BINARY:0,received_at_ms:BINARY:0,event_id:BINARY:0'
        AS bundle_index,
      (SELECT count(*) FROM pragma_index_list('${D1_INSIGHTS_INSTALLATION_ALIASES}')
        WHERE name = 'private_hot_updater_insights_alias_exact_idx'
          AND "unique" = 0 AND origin = 'c' AND partial = 0) = 1
        AS alias_exact_index_decl,
      (SELECT group_concat(name || ':' || coll || ':' || desc, ',') FROM (
        SELECT name, coll, desc FROM pragma_index_xinfo('private_hot_updater_insights_alias_exact_idx')
        WHERE key = 1 ORDER BY seqno
      )) = 'alias_kind:BINARY:0,alias_value:BINARY:0,alias_id:BINARY:0'
        AS alias_exact_index,
      (SELECT count(*) FROM pragma_index_list('${LIVE_INSTALLATIONS}')
        WHERE "unique" = 1 AND origin = 'pk' AND partial = 0) = 1
        AS live_index_decl,
      (SELECT group_concat(x.name || ':' || x.coll || ':' || x.desc, ',')
        FROM pragma_index_list('${LIVE_INSTALLATIONS}') AS list,
          pragma_index_xinfo(list.name) AS x
        WHERE list.origin = 'pk' AND x.key = 1) = 'install_key:BINARY:0'
        AS live_index,
      (SELECT count(*) FROM pragma_foreign_key_list('${SOURCE_EVENTS}')
        WHERE "table" = 'bundle_events' AND "from" = 'event_id' AND "to" = 'id'
          AND on_update = 'RESTRICT' AND on_delete = 'RESTRICT') = 1 AS source_fk,
      (SELECT count(*) FROM pragma_foreign_key_list('${PENDING_EVENTS}')
        WHERE "table" = 'bundle_events' AND "from" = 'event_id' AND "to" = 'id'
          AND on_update = 'RESTRICT' AND on_delete = 'RESTRICT') = 1 AS pending_fk,
      (SELECT count(*) FROM pragma_foreign_key_list('private_hot_updater_insights_installation_events')
        WHERE "table" = 'bundle_events' AND "from" = 'event_id' AND "to" = 'id'
          AND on_update = 'RESTRICT' AND on_delete = 'RESTRICT') = 1 AS installation_fk,
      (SELECT count(*) FROM pragma_foreign_key_list('private_hot_updater_insights_bundle_events')
        WHERE "table" = 'bundle_events' AND "from" = 'event_id' AND "to" = 'id'
          AND on_update = 'RESTRICT' AND on_delete = 'RESTRICT') = 1 AS bundle_fk,
      (SELECT count(*) FROM pragma_foreign_key_list('${LIVE_INSTALLATIONS}')
        WHERE "table" = 'bundle_events' AND "from" = 'event_id' AND "to" = 'id'
          AND on_update = 'RESTRICT' AND on_delete = 'RESTRICT') = 1 AS live_fk,
      (SELECT count(*) FROM pragma_foreign_key_list('${D1_INSIGHTS_INSTALLATION_VERSIONS}')
        WHERE "table" = 'bundle_events' AND "from" = 'event_id' AND "to" = 'id'
          AND on_update = 'RESTRICT' AND on_delete = 'RESTRICT') = 1 AS version_fk,
      (SELECT sql FROM sqlite_master WHERE type = 'trigger'
        AND name = 'bundle_events_insights_writer_fence'
        AND tbl_name = 'bundle_events') AS writer_trigger,
      (SELECT sql FROM sqlite_master WHERE type = 'trigger'
        AND name = 'bundle_events_insights_projection'
        AND tbl_name = 'bundle_events') AS projection_trigger,
      (SELECT sql FROM sqlite_master WHERE type = 'trigger'
        AND name = 'insights_live_install_key_collision'
        AND tbl_name = '${LIVE_INSTALLATIONS}') AS collision_trigger,
      (SELECT sql FROM sqlite_master WHERE type = 'trigger'
        AND name = 'insights_alias_install_key_collision'
        AND tbl_name = '${D1_INSIGHTS_INSTALLATION_ALIASES}')
        AS alias_collision_trigger`,
    [],
  );
  const row = rows[0];
  if (
    rows.length !== 1 ||
    !record(row) ||
    row.raw_columns !== 1 ||
    row.state_columns !== 1 ||
    schemaSql(row.state_table) !== schemaSql(SOURCE_STATE_TABLE_SQL) ||
    row.source_columns !== 1 ||
    schemaSql(row.source_table) !== schemaSql(SOURCE_EVENTS_TABLE_SQL) ||
    row.pending_columns !== 1 ||
    schemaSql(row.pending_table) !== schemaSql(PENDING_EVENTS_TABLE_SQL) ||
    row.installation_columns !== 1 ||
    schemaSql(row.installation_table) !==
      schemaSql(INSTALLATION_EVENTS_TABLE_SQL) ||
    row.bundle_columns !== 1 ||
    schemaSql(row.bundle_table) !== schemaSql(BUNDLE_EVENTS_TABLE_SQL) ||
    row.live_columns !== 1 ||
    schemaSql(row.live_table) !== schemaSql(LIVE_INSTALLATIONS_TABLE_SQL) ||
    row.alias_columns !== 1 ||
    schemaSql(row.alias_table) !== schemaSql(INSTALLATION_ALIASES_TABLE_SQL) ||
    row.version_columns !== 1 ||
    schemaSql(row.version_table) !==
      schemaSql(INSTALLATION_VERSIONS_TABLE_SQL) ||
    row.raw_id_column !== 1 ||
    row.raw_id_index_decl !== 1 ||
    row.raw_id_index !== 1 ||
    row.raw_index_decl !== 1 ||
    row.raw_index !== 1 ||
    row.raw_backfill_index_decl !== 1 ||
    row.raw_backfill_index !== 1 ||
    row.source_index_decl !== 1 ||
    row.source_index !== 1 ||
    row.installation_index_decl !== 1 ||
    row.installation_index !== 1 ||
    row.bundle_index_decl !== 1 ||
    row.bundle_index !== 1 ||
    row.alias_exact_index_decl !== 1 ||
    row.alias_exact_index !== 1 ||
    row.live_index_decl !== 1 ||
    row.live_index !== 1 ||
    row.source_fk !== 1 ||
    row.pending_fk !== 1 ||
    row.installation_fk !== 1 ||
    row.bundle_fk !== 1 ||
    row.live_fk !== 1 ||
    row.version_fk !== 1 ||
    schemaSql(row.writer_trigger) !== schemaSql(WRITER_TRIGGER_SQL) ||
    schemaSql(row.projection_trigger) !== schemaSql(PROJECTION_TRIGGER_SQL) ||
    schemaSql(row.collision_trigger) !== schemaSql(COLLISION_TRIGGER_SQL) ||
    schemaSql(row.alias_collision_trigger) !==
      schemaSql(ALIAS_COLLISION_TRIGGER_SQL)
  ) {
    throw new InsightsQueryNotReadyError();
  }
};

const publicEvent = (value: unknown): BundleEventRow => {
  if (!record(value)) return invalidResult();
  try {
    assertInsightsEventContract(value);
    assertInsightsEventRow(value);
  } catch {
    return invalidResult();
  }
  return value;
};

const storedEvent = (value: unknown): BundleEventRow => {
  if (
    !record(value) ||
    typeof value.event_json !== "string" ||
    !isCanonicalInsightsEventId(value.event_id) ||
    !safeInteger(value.received_at_ms) ||
    !safeInteger(value.row_bytes)
  ) {
    return invalidResult();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value.event_json);
  } catch {
    return invalidResult();
  }
  const event = publicEvent(parsed);
  if (
    canonicalInsightsJson(event) !== value.event_json ||
    event.id !== value.event_id ||
    event.received_at_ms !== value.received_at_ms ||
    eventBytes(event) !== value.row_bytes
  ) {
    return invalidResult();
  }
  return event;
};

export interface D1InsightsEventPointer {
  readonly eventId: string;
  readonly receivedAtMs: number;
  readonly rowBytes: number;
}

const pointerPrefix = <TPointer extends D1InsightsEventPointer>(
  pointers: readonly TPointer[],
  limit: number,
): readonly TPointer[] => {
  const selected: TPointer[] = [];
  let bytes = 2;
  for (const pointer of pointers.slice(0, limit)) {
    if (
      !isCanonicalInsightsEventId(pointer.eventId) ||
      !safeInteger(pointer.receivedAtMs) ||
      !safeInteger(pointer.rowBytes) ||
      pointer.rowBytes < 1 ||
      pointer.rowBytes > INSIGHTS_EVENT_MAX_BYTES
    ) {
      invalidResult();
    }
    const nextBytes =
      bytes + pointer.rowBytes + (selected.length === 0 ? 0 : 1);
    if (nextBytes > INSIGHTS_PAGE_MAX_BYTES) {
      break;
    }
    selected.push(pointer);
    bytes = nextBytes;
  }
  return selected;
};

export const readD1InsightsPointerEvents = async <
  TPointer extends D1InsightsEventPointer,
>(
  executor: D1Executor,
  pointers: readonly TPointer[],
  limit: number,
): Promise<readonly { pointer: TPointer; event: BundleEventRow }[]> => {
  const selected = pointerPrefix(pointers, limit);
  if (selected.length === 0) return [];
  const rows = await executor.query(
    `SELECT event_id, received_at_ms, row_bytes, event_json
    FROM ${SOURCE_EVENTS}
    WHERE event_id IN (SELECT value FROM json_each(?))`,
    [JSON.stringify(selected.map(({ eventId }) => eventId))],
  );
  if (rows.length !== selected.length) invalidResult();
  const events = new Map<string, BundleEventRow>();
  for (const value of rows) {
    const event = storedEvent(value);
    if (events.has(event.id)) invalidResult();
    events.set(event.id, event);
  }
  const saved = selected.map((pointer) => {
    const event = events.get(pointer.eventId);
    if (
      event === undefined ||
      event.received_at_ms !== pointer.receivedAtMs ||
      eventBytes(event) !== pointer.rowBytes
    ) {
      return invalidResult();
    }
    return { pointer, event };
  });
  const batch = saved.map(({ event }) => event);
  if (
    batch.length > INSIGHTS_PAGE_MAX_ROWS ||
    getCanonicalInsightsJsonByteLength(batch) > INSIGHTS_PAGE_MAX_BYTES
  ) {
    invalidResult();
  }
  return saved;
};

const readD1LegacyPointerEvents = async <
  TPointer extends D1InsightsEventPointer,
>(
  executor: D1Executor,
  pointers: readonly TPointer[],
  limit: number,
): Promise<readonly { pointer: TPointer; event: BundleEventRow }[]> => {
  const selected = pointerPrefix(pointers, limit);
  if (selected.length === 0) return [];
  const rows = await executor.query(
    `SELECT ${databaseFields.bundle_events.join(", ")}
    FROM bundle_events WHERE id IN (SELECT value FROM json_each(?))`,
    [JSON.stringify(selected.map(({ eventId }) => eventId))],
  );
  if (rows.length !== selected.length) invalidResult();
  const events = new Map<string, BundleEventRow>();
  for (const value of rows) {
    const event = publicEvent(value);
    if (events.has(event.id)) invalidResult();
    events.set(event.id, event);
  }
  return selected.map((pointer) => {
    const event = events.get(pointer.eventId);
    if (
      event === undefined ||
      event.received_at_ms !== pointer.receivedAtMs ||
      eventBytes(event) !== pointer.rowBytes
    ) {
      return invalidResult();
    }
    return { pointer, event };
  });
};

export const assertD1InsightsReady = async (
  executor: D1Executor,
): Promise<{ readonly sourceId: string; readonly generation: number }> => {
  await assertD1InsightsLayout(executor);
  const state = await readState(executor);
  if (state.status === "failed") {
    throw new D1InsightsMigrationPoisonError(state.source_id);
  }
  if (state.status !== "ready") throw new InsightsQueryNotReadyError();
  return { sourceId: state.source_id, generation: state.generation };
};

const generationValue = (value: unknown): number => {
  if (!safeInteger(value) || value < 1) return invalidResult();
  return value;
};

const parseGeneration = (
  value: string,
): { readonly sourceId: string; readonly upper: number } => {
  let parsed: unknown;
  try {
    if (typeof value !== "string" || value.length > 256) invalidQuery();
    parsed = JSON.parse(value);
  } catch {
    invalidQuery();
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 3 ||
    parsed[0] !== 2 ||
    typeof parsed[1] !== "string" ||
    !SOURCE_ID.test(parsed[1]) ||
    !safeInteger(parsed[2])
  ) {
    return invalidQuery();
  }
  return { sourceId: parsed[1], upper: parsed[2] };
};

const appendPreparedEventsStatements = async (
  statements: D1Statement[],
  events: readonly BundleEventRow[],
): Promise<{
  readonly events: readonly BundleEventRow[];
  readonly allocationIndex: number;
}> => {
  const payload: {
    readonly eventId: string;
    readonly receivedAtMs: number;
    readonly rowBytes: number;
    readonly eventJson: string;
    readonly installKey: string;
    readonly installId: string;
    readonly type: BundleEventRow["type"];
    readonly bundleId: string | null;
    readonly aliases: readonly D1InsightsAlias[];
  }[] = [];
  const installIds = new Map<string, string>();
  for (const event of events) {
    const installKey = await d1InsightsInstallKey(event.install_id);
    if (!INSTALL_KEY.test(installKey)) invalidResult();
    const prior = installIds.get(installKey);
    if (prior !== undefined && prior !== event.install_id) {
      throw new D1InsightsInstallKeyCollisionError();
    }
    installIds.set(installKey, event.install_id);
    const next = {
      eventId: event.id,
      receivedAtMs: event.received_at_ms,
      rowBytes: eventBytes(event),
      eventJson: canonicalInsightsJson(event),
      installKey,
      installId: event.install_id,
      type: event.type,
      bundleId:
        event.type === "UPDATE_APPLIED"
          ? event.to_bundle_id
          : event.type === "RECOVERED"
            ? event.from_bundle_id
            : null,
      aliases: eventAliases(event),
    };
    const encoded = JSON.stringify([...payload, next]);
    if (textEncoder.encode(encoded).byteLength > MAX_BACKFILL_PAYLOAD_BYTES) {
      break;
    }
    payload.push(next);
  }
  if (events.length > 0 && payload.length === 0) invalidResult();
  const selected = events.slice(0, payload.length);
  const encoded = JSON.stringify(payload);
  const allocationIndex = statements.length;
  statements.push(
    {
      sql: `UPDATE ${SOURCE_STATE} SET generation = generation + json_extract(?, '$')
        WHERE id = 1 AND version = 2 AND status = 'preparing'
          AND generation <= ${MAX_SAFE_GENERATION} - json_extract(?, '$')
        RETURNING generation`,
      params: encodeD1Values([payload.length, payload.length]),
    },
    {
      sql: `WITH payload AS (
          SELECT CAST(key AS INTEGER) AS ordinal, value FROM json_each(?)
        ), state AS (
          SELECT generation FROM ${SOURCE_STATE}
          WHERE id = 1 AND version = 2 AND status = 'preparing'
        )
        INSERT INTO ${SOURCE_EVENTS} (
          generation, event_id, received_at_ms, row_bytes, event_json
        ) SELECT state.generation - (SELECT count(*) FROM payload)
            + payload.ordinal + 1,
          json_extract(payload.value, '$.eventId'),
          json_extract(payload.value, '$.receivedAtMs'),
          json_extract(payload.value, '$.rowBytes'),
          json_extract(payload.value, '$.eventJson')
        FROM payload CROSS JOIN state`,
      params: [encoded],
    },
    {
      sql: `WITH payload AS (
          SELECT CAST(key AS INTEGER) AS ordinal, value FROM json_each(?)
        ), state AS (
          SELECT generation FROM ${SOURCE_STATE}
          WHERE id = 1 AND version = 2 AND status = 'preparing'
        )
        INSERT OR IGNORE INTO ${D1_INSIGHTS_INSTALLATION_ALIASES} (
          install_key, install_id, alias_kind, alias_value, folded_value,
          first_generation
        ) SELECT json_extract(payload.value, '$.installKey'),
          json_extract(payload.value, '$.installId'),
          json_extract(alias.value, '$.kind'),
          json_extract(alias.value, '$.value'),
          json_extract(alias.value, '$.folded'),
          state.generation - (SELECT count(*) FROM payload)
            + payload.ordinal + 1
        FROM payload CROSS JOIN state,
          json_each(json_extract(payload.value, '$.aliases')) AS alias`,
      params: [encoded],
    },
    {
      sql: `INSERT INTO private_hot_updater_insights_installation_events (
          install_id, received_at_ms, event_id, row_bytes
        ) SELECT json_extract(value, '$.installId'),
          json_extract(value, '$.receivedAtMs'),
          json_extract(value, '$.eventId'), json_extract(value, '$.rowBytes')
        FROM json_each(?)
        WHERE json_extract(value, '$.type') IN ('UPDATE_APPLIED', 'RECOVERED')`,
      params: [encoded],
    },
    {
      sql: `INSERT INTO private_hot_updater_insights_bundle_events (
          bundle_id, received_at_ms, event_id, row_bytes
        ) SELECT json_extract(value, '$.bundleId'),
          json_extract(value, '$.receivedAtMs'),
          json_extract(value, '$.eventId'), json_extract(value, '$.rowBytes')
        FROM json_each(?)
        WHERE json_extract(value, '$.type') IN ('UPDATE_APPLIED', 'RECOVERED')`,
      params: [encoded],
    },
    {
      sql: `INSERT INTO ${LIVE_INSTALLATIONS} (
          install_key, install_id, event_id, received_at_ms, row_bytes
        ) SELECT install_key, install_id, event_id, received_at_ms, row_bytes
        FROM (
          SELECT json_extract(value, '$.installKey') AS install_key,
            json_extract(value, '$.installId') AS install_id,
            json_extract(value, '$.eventId') AS event_id,
            json_extract(value, '$.receivedAtMs') AS received_at_ms,
            json_extract(value, '$.rowBytes') AS row_bytes,
            row_number() OVER (
              PARTITION BY json_extract(value, '$.installKey')
              ORDER BY json_extract(value, '$.receivedAtMs') DESC,
                json_extract(value, '$.eventId') COLLATE BINARY DESC
            ) AS rank
          FROM json_each(?)
        ) WHERE rank = 1
        ON CONFLICT(install_key) DO UPDATE SET
          event_id = excluded.event_id,
          received_at_ms = excluded.received_at_ms,
          row_bytes = excluded.row_bytes
        WHERE ${LIVE_INSTALLATIONS}.install_id = excluded.install_id
          AND (${LIVE_INSTALLATIONS}.received_at_ms < excluded.received_at_ms
            OR (${LIVE_INSTALLATIONS}.received_at_ms = excluded.received_at_ms
              AND ${LIVE_INSTALLATIONS}.event_id < excluded.event_id))`,
      params: [encoded],
    },
    {
      sql: `WITH affected AS (
          SELECT DISTINCT json_extract(value, '$.installKey') AS install_key
          FROM json_each(?)
        ), state AS (
          SELECT generation FROM ${SOURCE_STATE}
          WHERE id = 1 AND version = 2 AND status = 'preparing'
        )
        INSERT INTO ${D1_INSIGHTS_INSTALLATION_VERSIONS} (
          install_key, generation, install_id, event_id, received_at_ms,
          row_bytes
        ) SELECT live.install_key, state.generation, live.install_id,
          live.event_id, live.received_at_ms, live.row_bytes
        FROM affected JOIN ${LIVE_INSTALLATIONS} AS live
          ON live.install_key = affected.install_key
        CROSS JOIN state`,
      params: [encoded],
    },
  );
  return { events: selected, allocationIndex };
};

const poisonPreparation = async (
  executor: D1Executor,
  state: SourceState,
): Promise<never> => {
  const rows = await executor.query(
    `UPDATE ${SOURCE_STATE} SET status = 'failed'
    WHERE id = 1 AND version = 2 AND status = 'preparing'
      AND generation = json_extract(?, '$')
      AND backfill_upper_received_at_ms IS json_extract(?, '$')
      AND backfill_upper_id IS json_extract(?, '$')
      AND backfill_after_received_at_ms IS json_extract(?, '$')
      AND backfill_after_id IS json_extract(?, '$')
    RETURNING status`,
    encodeD1Values([
      state.generation,
      state.backfill_upper_received_at_ms,
      state.backfill_upper_id,
      state.backfill_after_received_at_ms,
      state.backfill_after_id,
    ]),
  );
  if (rows.length !== 1) throw new InsightsQueryNotReadyError();
  throw new D1InsightsMigrationPoisonError(state.source_id);
};

const assertRecoverableProjectionIdentity = async (
  executor: D1Executor,
  event: BundleEventRow,
  sourceId: string,
): Promise<void> => {
  const installKey = await d1InsightsInstallKey(event.install_id);
  const aliases = canonicalInsightsJson(eventAliases(event));
  const rows = await executor.query(
    `WITH expected_aliases AS (
        SELECT json_extract(value, '$.kind') AS alias_kind,
          json_extract(value, '$.value') AS alias_value,
          json_extract(value, '$.folded') AS folded_value
        FROM json_each(?)
      )
      SELECT CASE WHEN
        EXISTS (
          SELECT 1 FROM ${LIVE_INSTALLATIONS}
          WHERE install_key = json_extract(?, '$') COLLATE BINARY
            AND install_id <> json_extract(?, '$')
        ) OR EXISTS (
          SELECT 1 FROM ${D1_INSIGHTS_INSTALLATION_ALIASES}
          WHERE install_key = json_extract(?, '$') COLLATE BINARY
            AND install_id <> json_extract(?, '$')
        ) OR EXISTS (
          SELECT 1 FROM ${D1_INSIGHTS_INSTALLATION_VERSIONS}
          WHERE install_key = json_extract(?, '$') COLLATE BINARY
            AND install_id <> json_extract(?, '$')
        ) OR EXISTS (
          SELECT 1 FROM expected_aliases AS expected
          JOIN ${D1_INSIGHTS_INSTALLATION_ALIASES} AS saved
            ON saved.install_key = json_extract(?, '$') COLLATE BINARY
            AND saved.alias_kind = expected.alias_kind
            AND saved.alias_value = expected.alias_value COLLATE BINARY
          WHERE saved.install_id <> json_extract(?, '$')
            OR saved.folded_value <> expected.folded_value COLLATE BINARY
        ) THEN 1 ELSE 0 END AS identity_conflict`,
    [
      aliases,
      ...encodeD1Values([
        installKey,
        event.install_id,
        installKey,
        event.install_id,
        installKey,
        event.install_id,
        installKey,
        event.install_id,
      ]),
    ],
  );
  if (
    rows.length !== 1 ||
    !record(rows[0]) ||
    (rows[0].identity_conflict !== 0 && rows[0].identity_conflict !== 1) ||
    rows[0].identity_conflict === 1
  ) {
    throw new D1InsightsMigrationPoisonError(sourceId);
  }
};

export const createD1InsightsSourceTools = (executor: D1Executor) => ({
  async recoverFailedPreparation(): Promise<{ readonly recovered: boolean }> {
    await assertD1InsightsLayout(executor);
    const state = await readState(executor);
    if (state.status !== "failed") return { recovered: false };
    const upper = state.backfill_upper_id;
    const upperTime = state.backfill_upper_received_at_ms;
    const after = state.backfill_after_id;
    const afterTime = state.backfill_after_received_at_ms;
    const legacyComplete =
      upper === null || (after === upper && afterTime === upperTime);
    let nextEvent: BundleEventRow | null = null;
    try {
      if (legacyComplete) {
        const rows = await executor.query(
          `SELECT sequence, event_id, received_at_ms, row_bytes, event_json
          FROM ${PENDING_EVENTS}
          ORDER BY sequence ASC LIMIT 1`,
          [],
        );
        if (rows.length > 1) invalidResult();
        if (rows[0] !== undefined) {
          const row = rows[0];
          if (
            !record(row) ||
            !safeInteger(row.sequence) ||
            !isCanonicalInsightsEventId(row.event_id) ||
            !safeInteger(row.received_at_ms) ||
            !safeInteger(row.row_bytes)
          ) {
            invalidResult();
          }
          nextEvent = storedEvent(row);
        }
      } else {
        if (upper === null || upperTime === null) invalidResult();
        const rows = await executor.query(
          `SELECT id, received_at_ms, ${LEGACY_EVENT_BYTES_SQL} AS row_bytes
          FROM bundle_events INDEXED BY bundle_events_insights_backfill_idx
          WHERE insights_write_version IS NULL AND ${
            afterTime === null
              ? ""
              : `(received_at_ms, id COLLATE BINARY) >
                (json_extract(?, '$'), json_extract(?, '$') COLLATE BINARY)
                AND `
          }(received_at_ms, id COLLATE BINARY) <=
            (json_extract(?, '$'), json_extract(?, '$') COLLATE BINARY)
          ORDER BY received_at_ms ASC, id COLLATE BINARY ASC LIMIT 1`,
          encodeD1Values([
            ...(afterTime === null ? [] : [afterTime, after]),
            upperTime,
            upper,
          ]),
        );
        if (rows.length !== 1) invalidResult();
        const row = record(rows[0]) ? rows[0] : invalidResult();
        const eventId = isCanonicalInsightsEventId(row.id)
          ? row.id
          : invalidResult();
        const receivedAtMs = safeInteger(row.received_at_ms)
          ? row.received_at_ms
          : invalidResult();
        const rowBytes = safeInteger(row.row_bytes)
          ? row.row_bytes
          : invalidResult();
        if (rowBytes < 1 || rowBytes > INSIGHTS_EVENT_MAX_BYTES) {
          invalidResult();
        }
        const saved = await readD1LegacyPointerEvents(
          executor,
          [
            {
              eventId,
              receivedAtMs,
              rowBytes,
            },
          ],
          1,
        );
        nextEvent = saved[0]?.event ?? invalidResult();
      }
    } catch (error) {
      if (isProvenCorruption(error)) {
        throw new D1InsightsMigrationPoisonError(state.source_id);
      }
      throw error;
    }
    if (nextEvent !== null) {
      await assertRecoverableProjectionIdentity(
        executor,
        nextEvent,
        state.source_id,
      );
    }
    const rows = await executor.query(
      `UPDATE ${SOURCE_STATE} SET status = 'preparing'
      WHERE id = 1 AND version = 2 AND status = 'failed'
        AND generation = json_extract(?, '$')
        AND backfill_upper_received_at_ms IS json_extract(?, '$')
        AND backfill_upper_id IS json_extract(?, '$')
        AND backfill_after_received_at_ms IS json_extract(?, '$')
        AND backfill_after_id IS json_extract(?, '$')
      RETURNING status`,
      encodeD1Values([state.generation, upperTime, upper, afterTime, after]),
    );
    if (rows.length !== 1) throw new InsightsQueryNotReadyError();
    return { recovered: true };
  },

  async capture(): Promise<string> {
    const state = await assertD1InsightsReady(executor);
    return JSON.stringify([2, state.sourceId, state.generation]);
  },

  async readPage(input: {
    readonly sourceGeneration: string;
    readonly afterGeneration?: number;
    readonly limit: number;
  }): Promise<readonly { generation: number; event: BundleEventRow }[]> {
    const source = parseGeneration(input.sourceGeneration);
    const after = input.afterGeneration ?? 0;
    if (
      !safeInteger(after) ||
      after > source.upper ||
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > INSIGHTS_PAGE_MAX_ROWS
    ) {
      invalidQuery();
    }
    await assertD1InsightsLayout(executor);
    const state = await readState(executor);
    if (state.status === "failed") {
      throw new D1InsightsMigrationPoisonError(state.source_id);
    }
    if (state.status !== "ready" || state.source_id !== source.sourceId) {
      throw new InsightsQueryNotReadyError();
    }
    const rows = await executor.query(
      `SELECT source.generation AS source_generation, source.event_id,
        source.received_at_ms, source.row_bytes
      FROM ${SOURCE_EVENTS} AS source
      WHERE source.generation > json_extract(?, '$')
        AND source.generation <= json_extract(?, '$')
      ORDER BY source.generation ASC
      LIMIT json_extract(?, '$')`,
      encodeD1Values([after, source.upper, input.limit]),
    );
    if (rows.length > input.limit) invalidResult();
    let previous = after;
    const pointers = rows.map((value) => {
      if (!record(value)) return invalidResult();
      const generation = generationValue(value.source_generation);
      if (generation !== previous + 1 || generation > source.upper) {
        invalidResult();
      }
      previous = generation;
      return {
        generation,
        eventId: isCanonicalInsightsEventId(value.event_id)
          ? value.event_id
          : invalidResult(),
        receivedAtMs: safeInteger(value.received_at_ms)
          ? value.received_at_ms
          : invalidResult(),
        rowBytes: safeInteger(value.row_bytes)
          ? value.row_bytes
          : invalidResult(),
      };
    });
    if (rows.length < input.limit && previous !== source.upper) invalidResult();
    return (
      await readD1InsightsPointerEvents(executor, pointers, input.limit)
    ).map(({ pointer, event }) => ({
      generation: pointer.generation,
      event,
    }));
  },

  async backfillStep(
    limit: number,
  ): Promise<{ readonly ready: boolean; readonly processed: number }> {
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > MAX_BACKFILL_PAGE
    ) {
      invalidQuery();
    }
    await assertD1InsightsLayout(executor);
    const state = await readState(executor);
    if (state.status === "failed") {
      throw new D1InsightsMigrationPoisonError(state.source_id);
    }
    if (state.status === "ready") return { ready: true, processed: 0 };
    const upper = state.backfill_upper_id;
    const upperTime = state.backfill_upper_received_at_ms;
    const after = state.backfill_after_id;
    const afterTime = state.backfill_after_received_at_ms;
    const legacyComplete =
      upper === null || (after === upper && afterTime === upperTime);
    if (legacyComplete) {
      const rows = await executor.query(
        `SELECT sequence, event_id, received_at_ms, row_bytes, event_json
        FROM ${PENDING_EVENTS}
        ORDER BY sequence ASC LIMIT json_extract(?, '$')`,
        encodeD1Values([limit]),
      );
      if (rows.length > limit) return invalidResult();
      let events: readonly BundleEventRow[];
      try {
        let previousSequence = 0;
        events = rows.map((row) => {
          if (
            !record(row) ||
            !safeInteger(row.sequence) ||
            row.sequence <= previousSequence ||
            !isCanonicalInsightsEventId(row.event_id) ||
            !safeInteger(row.received_at_ms) ||
            !safeInteger(row.row_bytes)
          ) {
            return invalidResult();
          }
          previousSequence = row.sequence;
          return storedEvent(row);
        });
      } catch (error) {
        if (isProvenCorruption(error)) {
          return poisonPreparation(executor, state);
        }
        throw error;
      }
      const guard: D1Statement = {
        sql: `SELECT CASE WHEN EXISTS (
          SELECT 1 FROM ${SOURCE_STATE}
          WHERE id = 1 AND version = 2 AND status = 'preparing'
            AND generation = json_extract(?, '$')
            AND backfill_upper_received_at_ms IS json_extract(?, '$')
            AND backfill_upper_id IS json_extract(?, '$')
            AND backfill_after_received_at_ms IS json_extract(?, '$')
            AND backfill_after_id IS json_extract(?, '$')
        ) THEN 1 ELSE json_extract('HOT_UPDATER_INSIGHTS_STALE_PREPARER', '$')
        END AS preparation_guard`,
        params: encodeD1Values([
          state.generation,
          upperTime,
          upper,
          afterTime,
          after,
        ]),
      };
      const statements: D1Statement[] = [guard];
      let prepared: Awaited<ReturnType<typeof appendPreparedEventsStatements>>;
      try {
        prepared = await appendPreparedEventsStatements(statements, events);
      } catch (error) {
        if (isInstallKeyCollision(error)) {
          return poisonPreparation(executor, state);
        }
        throw error;
      }
      events = prepared.events;
      if (events.length > 0) {
        statements.push({
          sql: `DELETE FROM ${PENDING_EVENTS}
            WHERE event_id IN (SELECT value FROM json_each(?))`,
          params: [JSON.stringify(events.map(({ id }) => id))],
        });
      }
      statements.push({
        sql: `UPDATE ${SOURCE_STATE}
          SET status = CASE WHEN NOT EXISTS (
            SELECT 1 FROM ${PENDING_EVENTS}
          ) THEN 'ready' ELSE 'preparing' END
          WHERE id = 1 AND version = 2 AND status = 'preparing'
          RETURNING status`,
        params: [],
      });
      if (statements.length > 50) return invalidResult();
      let results: readonly (readonly unknown[])[];
      try {
        results = await executor.batch(statements);
      } catch (error) {
        if (isInstallKeyCollision(error)) {
          return poisonPreparation(executor, state);
        }
        throw error;
      }
      const marker = results.at(-1);
      if (
        results.length !== statements.length ||
        marker?.length !== 1 ||
        !record(marker[0]) ||
        (marker[0].status !== "ready" && marker[0].status !== "preparing") ||
        results[prepared.allocationIndex]?.length !== 1
      ) {
        return invalidResult();
      }
      return {
        ready: marker[0].status === "ready",
        processed: events.length,
      };
    }
    if (upper === null || upperTime === null) return invalidResult();
    const rows = await executor.query(
      `SELECT id, received_at_ms, ${LEGACY_EVENT_BYTES_SQL} AS row_bytes
      FROM bundle_events INDEXED BY bundle_events_insights_backfill_idx
      WHERE insights_write_version IS NULL AND ${
        afterTime === null
          ? ""
          : `(received_at_ms, id COLLATE BINARY) >
            (json_extract(?, '$'), json_extract(?, '$') COLLATE BINARY) AND `
      }(received_at_ms, id COLLATE BINARY) <=
        (json_extract(?, '$'), json_extract(?, '$') COLLATE BINARY)
      ORDER BY received_at_ms ASC, id COLLATE BINARY ASC
      LIMIT json_extract(?, '$')`,
      encodeD1Values([
        ...(afterTime === null ? [] : [afterTime, after]),
        upperTime,
        upper,
        limit,
      ]),
    );
    if (rows.length === 0) invalidResult();
    let events: readonly BundleEventRow[];
    try {
      let previousTime = afterTime;
      let previousId = after;
      const pointers = rows.map((row) => {
        if (
          !record(row) ||
          !isCanonicalInsightsEventId(row.id) ||
          !safeInteger(row.received_at_ms) ||
          !safeInteger(row.row_bytes) ||
          row.row_bytes < 1 ||
          row.row_bytes > INSIGHTS_EVENT_MAX_BYTES ||
          (previousTime !== null &&
            (row.received_at_ms < previousTime ||
              (row.received_at_ms === previousTime &&
                (previousId === null || row.id <= previousId)))) ||
          row.received_at_ms > upperTime ||
          (row.received_at_ms === upperTime && row.id > upper)
        ) {
          return invalidResult();
        }
        previousTime = row.received_at_ms;
        previousId = row.id;
        return {
          eventId: row.id,
          receivedAtMs: row.received_at_ms,
          rowBytes: row.row_bytes,
        };
      });
      const scannedLast = pointers.at(-1)!;
      if (
        rows.length < limit &&
        !(
          scannedLast.eventId === upper &&
          scannedLast.receivedAtMs === upperTime
        )
      ) {
        invalidResult();
      }
      events = (await readD1LegacyPointerEvents(executor, pointers, limit)).map(
        ({ event }) => event,
      );
      if (events.length === 0) invalidResult();
    } catch (error) {
      if (isProvenCorruption(error)) {
        return poisonPreparation(executor, state);
      }
      throw error;
    }
    const staleGuard: D1Statement = {
      sql: `SELECT CASE WHEN EXISTS (
        SELECT 1 FROM ${SOURCE_STATE}
        WHERE id = 1 AND version = 2 AND status = 'preparing'
          AND backfill_upper_id = json_extract(?, '$')
          AND backfill_upper_received_at_ms = json_extract(?, '$')
          AND backfill_after_id IS json_extract(?, '$')
          AND backfill_after_received_at_ms IS json_extract(?, '$')
      ) THEN 1 ELSE json_extract('HOT_UPDATER_INSIGHTS_STALE_PREPARER', '$')
      END AS preparation_guard`,
      params: encodeD1Values([upper, upperTime, after, afterTime]),
    };
    const statements: D1Statement[] = [staleGuard];
    let prepared: Awaited<ReturnType<typeof appendPreparedEventsStatements>>;
    try {
      prepared = await appendPreparedEventsStatements(statements, events);
    } catch (error) {
      if (isInstallKeyCollision(error)) {
        return poisonPreparation(executor, state);
      }
      throw error;
    }
    events = prepared.events;
    const selectedLast = events.at(-1) ?? invalidResult();
    const selectedLastTime = selectedLast.received_at_ms;
    const selectedLastId = selectedLast.id;
    statements.push({
      sql: `UPDATE ${SOURCE_STATE}
        SET backfill_after_received_at_ms = json_extract(?, '$'),
          backfill_after_id = json_extract(?, '$'),
          status = 'preparing'
        WHERE id = 1 AND version = 2 AND status = 'preparing'
          AND backfill_upper_received_at_ms = json_extract(?, '$')
          AND backfill_upper_id = json_extract(?, '$')
          AND backfill_after_received_at_ms IS json_extract(?, '$')
          AND backfill_after_id IS json_extract(?, '$')
        RETURNING status`,
      params: encodeD1Values([
        selectedLastTime,
        selectedLastId,
        upperTime,
        upper,
        afterTime,
        after,
      ]),
    });
    if (statements.length > 50) invalidResult();
    let results: readonly (readonly unknown[])[];
    try {
      results = await executor.batch(statements);
    } catch (error) {
      if (isInstallKeyCollision(error)) {
        return poisonPreparation(executor, state);
      }
      throw error;
    }
    if (
      results.length !== statements.length ||
      results.at(-1)?.length !== 1 ||
      results[prepared.allocationIndex]?.length !== 1
    ) {
      invalidResult();
    }
    return { ready: false, processed: events.length };
  },
});
