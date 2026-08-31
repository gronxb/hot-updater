import {
  DatabasePluginInputError,
  InsightsQueryNotReadyError,
  type BundleEventRow,
} from "@hot-updater/plugin-core";
import {
  assertInsightsEventRow,
  databaseFields,
} from "@hot-updater/plugin-core/internal";

import type { D1Executor, D1Statement } from "./d1Implementation";
import { d1Placeholders, encodeD1Values } from "./d1Sql";

const SOURCE_STATE = "private_hot_updater_insights_source_state";
const SOURCE_EVENTS = "private_hot_updater_insights_source_events";
const LIVE_INSTALLATIONS = "private_hot_updater_insights_live_installations";
const SOURCE_ID = /^[0-9a-f]{32}$/;
const INSTALL_KEY = /^[0-9a-f]{64}$/;
const MAX_SOURCE_PAGE = 100;
const MAX_BACKFILL_PAGE = 6;
const MAX_SAFE_GENERATION = Number.MAX_SAFE_INTEGER;
const MAX_D1_ROW_BYTES = 2_000_000;
const PAGE_BYTE_BUDGET = 1_048_576;
const textEncoder = new TextEncoder();

const WRITER_TRIGGER_SQL = `CREATE TRIGGER bundle_events_insights_writer_fence
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

const PROJECTION_TRIGGER_SQL = `CREATE TRIGGER bundle_events_insights_projection
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
END`;

const schemaSql = (value: unknown): string | null =>
  typeof value === "string" ? value.replace(/\s+/g, "").toLowerCase() : null;

const invalidQuery = (): never => {
  throw new DatabasePluginInputError("invalid-query");
};

const invalidResult = (): never => {
  throw new DatabasePluginInputError("invalid-result");
};

const record = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const safeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const eventIdentifier = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 1_024;

const eventJson = (row: BundleEventRow): string => {
  assertInsightsEventRow(row);
  return JSON.stringify(row);
};

const eventBytes = (row: BundleEventRow): number => {
  const bytes = textEncoder.encode(eventJson(row)).byteLength;
  if (bytes < 1 || bytes > MAX_D1_ROW_BYTES) {
    throw new DatabasePluginInputError("invalid-data");
  }
  return bytes;
};

const bytesToHex = (bytes: Uint8Array): string =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

export const d1InsightsInstallKey = async (
  installId: string,
): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    textEncoder.encode(JSON.stringify(installId)),
  );
  return bytesToHex(new Uint8Array(digest));
};

export const createD1InsightsEventInsert = async (
  row: BundleEventRow,
  guard?: { readonly sql: string; readonly params: readonly string[] },
  returnRow = true,
): Promise<D1Statement> => {
  eventJson(row);
  const installKey = await d1InsightsInstallKey(row.install_id);
  const columns = [
    ...databaseFields.bundle_events,
    "insights_write_version",
    "insights_install_key",
    "insights_row_bytes",
  ];
  const values = [
    ...databaseFields.bundle_events.map((field) => row[field]),
    2,
    installKey,
    eventBytes(row),
  ];
  return {
    sql: `INSERT INTO bundle_events (${columns.join(", ")}) ${
      guard === undefined
        ? `VALUES (${d1Placeholders(values.length)})`
        : `SELECT ${d1Placeholders(values.length)} WHERE ${guard.sql}`
    }${
      returnRow ? ` RETURNING ${databaseFields.bundle_events.join(", ")}` : ""
    }`,
    params: [...encodeD1Values(values), ...(guard?.params ?? [])],
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
          'insights_write_version', 'insights_install_key', 'insights_row_bytes'
        ) ORDER BY cid
      )) = 'insights_write_version:INTEGER:0,insights_install_key:TEXT:0,insights_row_bytes:INTEGER:0'
        AS raw_columns,
      (SELECT group_concat(name || ':' || type || ':' || "notnull" || ':' || pk, ',') FROM (
        SELECT name, type, "notnull", pk
        FROM pragma_table_info('${SOURCE_STATE}') ORDER BY cid
      )) = 'id:INTEGER:1:1,version:INTEGER:1:0,source_id:TEXT:1:0,status:TEXT:1:0,generation:INTEGER:1:0,backfill_upper_received_at_ms:REAL:0:0,backfill_upper_id:TEXT:0:0,backfill_after_received_at_ms:REAL:0:0,backfill_after_id:TEXT:0:0'
        AS state_columns,
      (SELECT group_concat(name || ':' || type || ':' || "notnull" || ':' || pk, ',') FROM (
        SELECT name, type, "notnull", pk
        FROM pragma_table_info('${SOURCE_EVENTS}') ORDER BY cid
      )) = 'generation:INTEGER:1:1,event_id:TEXT:1:0,received_at_ms:REAL:1:0,row_bytes:INTEGER:1:0'
        AS source_columns,
      (SELECT group_concat(name || ':' || type || ':' || "notnull" || ':' || pk, ',') FROM (
        SELECT name, type, "notnull", pk
        FROM pragma_table_info('private_hot_updater_insights_installation_events')
        ORDER BY cid
      )) = 'install_id:TEXT:1:0,received_at_ms:REAL:1:0,event_id:TEXT:1:1,row_bytes:INTEGER:1:0'
        AS installation_columns,
      (SELECT group_concat(name || ':' || type || ':' || "notnull" || ':' || pk, ',') FROM (
        SELECT name, type, "notnull", pk
        FROM pragma_table_info('private_hot_updater_insights_bundle_events')
        ORDER BY cid
      )) = 'bundle_id:TEXT:1:0,received_at_ms:REAL:1:0,event_id:TEXT:1:1,row_bytes:INTEGER:1:0'
        AS bundle_columns,
      (SELECT group_concat(name || ':' || type || ':' || "notnull" || ':' || pk, ',') FROM (
        SELECT name, type, "notnull", pk
        FROM pragma_table_info('${LIVE_INSTALLATIONS}') ORDER BY cid
      )) = 'install_key:TEXT:1:1,install_id:TEXT:1:0,event_id:TEXT:1:0,received_at_ms:REAL:1:0,row_bytes:INTEGER:1:0'
        AS live_columns,
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
      (SELECT count(*) FROM pragma_foreign_key_list('private_hot_updater_insights_installation_events')
        WHERE "table" = 'bundle_events' AND "from" = 'event_id' AND "to" = 'id'
          AND on_update = 'RESTRICT' AND on_delete = 'RESTRICT') = 1 AS installation_fk,
      (SELECT count(*) FROM pragma_foreign_key_list('private_hot_updater_insights_bundle_events')
        WHERE "table" = 'bundle_events' AND "from" = 'event_id' AND "to" = 'id'
          AND on_update = 'RESTRICT' AND on_delete = 'RESTRICT') = 1 AS bundle_fk,
      (SELECT count(*) FROM pragma_foreign_key_list('${LIVE_INSTALLATIONS}')
        WHERE "table" = 'bundle_events' AND "from" = 'event_id' AND "to" = 'id'
          AND on_update = 'RESTRICT' AND on_delete = 'RESTRICT') = 1 AS live_fk,
      (SELECT sql FROM sqlite_master WHERE type = 'trigger'
        AND name = 'bundle_events_insights_writer_fence'
        AND tbl_name = 'bundle_events') AS writer_trigger,
      (SELECT sql FROM sqlite_master WHERE type = 'trigger'
        AND name = 'bundle_events_insights_projection'
        AND tbl_name = 'bundle_events') AS projection_trigger,
      (SELECT sql FROM sqlite_master WHERE type = 'trigger'
        AND name = 'insights_live_install_key_collision'
        AND tbl_name = '${LIVE_INSTALLATIONS}') AS collision_trigger`,
    [],
  );
  const row = rows[0];
  if (
    rows.length !== 1 ||
    !record(row) ||
    row.raw_columns !== 1 ||
    row.state_columns !== 1 ||
    row.source_columns !== 1 ||
    row.installation_columns !== 1 ||
    row.bundle_columns !== 1 ||
    row.live_columns !== 1 ||
    row.raw_id_column !== 1 ||
    row.raw_id_index_decl !== 1 ||
    row.raw_id_index !== 1 ||
    row.raw_index_decl !== 1 ||
    row.raw_index !== 1 ||
    row.source_index_decl !== 1 ||
    row.source_index !== 1 ||
    row.installation_index_decl !== 1 ||
    row.installation_index !== 1 ||
    row.bundle_index_decl !== 1 ||
    row.bundle_index !== 1 ||
    row.live_index_decl !== 1 ||
    row.live_index !== 1 ||
    row.source_fk !== 1 ||
    row.installation_fk !== 1 ||
    row.bundle_fk !== 1 ||
    row.live_fk !== 1 ||
    schemaSql(row.writer_trigger) !== schemaSql(WRITER_TRIGGER_SQL) ||
    schemaSql(row.projection_trigger) !== schemaSql(PROJECTION_TRIGGER_SQL) ||
    schemaSql(row.collision_trigger) !== schemaSql(COLLISION_TRIGGER_SQL)
  ) {
    throw new InsightsQueryNotReadyError();
  }
};

const publicEvent = (value: unknown): BundleEventRow => {
  if (!record(value)) return invalidResult();
  const row = Object.fromEntries(
    databaseFields.bundle_events.map((field) => [field, value[field]]),
  ) as unknown as BundleEventRow;
  assertInsightsEventRow(row);
  return row;
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
  let bytes = 0;
  for (const pointer of pointers.slice(0, limit)) {
    if (
      !eventIdentifier(pointer.eventId) ||
      !safeInteger(pointer.receivedAtMs) ||
      !safeInteger(pointer.rowBytes) ||
      pointer.rowBytes < 1 ||
      pointer.rowBytes > MAX_D1_ROW_BYTES
    ) {
      invalidResult();
    }
    if (selected.length > 0 && bytes + pointer.rowBytes > PAGE_BYTE_BUDGET) {
      break;
    }
    selected.push(pointer);
    bytes += pointer.rowBytes;
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

const liveUpsert = (row: BundleEventRow, installKey: string): D1Statement => ({
  sql: `INSERT INTO ${LIVE_INSTALLATIONS}
    (install_key, install_id, event_id, received_at_ms, row_bytes)
    VALUES (
      json_extract(?, '$'), json_extract(?, '$'), json_extract(?, '$'),
      json_extract(?, '$'), json_extract(?, '$')
    )
    ON CONFLICT(install_key) DO UPDATE SET
      event_id = excluded.event_id,
      received_at_ms = excluded.received_at_ms,
      row_bytes = excluded.row_bytes
    WHERE ${LIVE_INSTALLATIONS}.install_id = excluded.install_id
      AND (${LIVE_INSTALLATIONS}.received_at_ms < excluded.received_at_ms
        OR (${LIVE_INSTALLATIONS}.received_at_ms = excluded.received_at_ms
          AND ${LIVE_INSTALLATIONS}.event_id < excluded.event_id))`,
  params: encodeD1Values([
    installKey,
    row.install_id,
    row.id,
    row.received_at_ms,
    eventBytes(row),
  ]),
});

export const createD1InsightsSourceTools = (executor: D1Executor) => ({
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
      input.limit > MAX_SOURCE_PAGE
    ) {
      invalidQuery();
    }
    await assertD1InsightsLayout(executor);
    const state = await readState(executor);
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
        eventId:
          typeof value.event_id === "string" ? value.event_id : invalidResult(),
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
    if (state.status === "failed") throw new InsightsQueryNotReadyError();
    if (state.status === "ready") return { ready: true, processed: 0 };
    const upper = state.backfill_upper_id;
    const upperTime = state.backfill_upper_received_at_ms;
    const after = state.backfill_after_id;
    const afterTime = state.backfill_after_received_at_ms;
    if (upper === null || upperTime === null) {
      const results = await executor.batch([
        {
          sql: `UPDATE ${SOURCE_STATE} SET status = 'ready'
            WHERE id = 1 AND version = 2 AND status = 'preparing'
              AND backfill_upper_received_at_ms IS NULL
              AND backfill_upper_id IS NULL
              AND backfill_after_received_at_ms IS NULL
              AND backfill_after_id IS NULL
            RETURNING status`,
          params: [],
        },
      ]);
      if (results[0]?.length !== 1) throw new InsightsQueryNotReadyError();
      return { ready: true, processed: 0 };
    }
    const rows = await executor.query(
      `SELECT ${databaseFields.bundle_events.join(", ")}
      FROM bundle_events INDEXED BY bundle_events_received_at_idx
      WHERE ${
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
    const events = rows.map(publicEvent);
    const lastEvent = events.at(-1)!;
    const last = lastEvent.id;
    const lastTime = lastEvent.received_at_ms;
    const ready = last === upper && lastTime === upperTime;
    if (rows.length < limit && !ready) invalidResult();
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
    const allocationIndexes: number[] = [];
    for (const event of events) {
      const installKey = await d1InsightsInstallKey(event.install_id);
      if (!INSTALL_KEY.test(installKey)) invalidResult();
      const rowBytes = eventBytes(event);
      allocationIndexes.push(statements.length);
      statements.push(
        {
          sql: `UPDATE ${SOURCE_STATE} SET generation = generation + 1
            WHERE id = 1 AND version = 2 AND status = 'preparing'
              AND generation < ${MAX_SAFE_GENERATION}
            RETURNING generation`,
          params: [],
        },
        {
          sql: `INSERT INTO ${SOURCE_EVENTS}
            (generation, event_id, received_at_ms, row_bytes)
            SELECT generation, json_extract(?, '$'), json_extract(?, '$'),
              json_extract(?, '$') FROM ${SOURCE_STATE}
            WHERE id = 1 AND version = 2 AND status = 'preparing'`,
          params: encodeD1Values([event.id, event.received_at_ms, rowBytes]),
        },
      );
      if (event.type === "UPDATE_APPLIED" || event.type === "RECOVERED") {
        statements.push(
          {
            sql: `INSERT INTO private_hot_updater_insights_installation_events
              (install_id, received_at_ms, event_id, row_bytes)
              VALUES (json_extract(?, '$'), json_extract(?, '$'),
                json_extract(?, '$'), json_extract(?, '$'))`,
            params: encodeD1Values([
              event.install_id,
              event.received_at_ms,
              event.id,
              rowBytes,
            ]),
          },
          {
            sql: `INSERT INTO private_hot_updater_insights_bundle_events
              (bundle_id, received_at_ms, event_id, row_bytes)
              VALUES (json_extract(?, '$'), json_extract(?, '$'),
                json_extract(?, '$'), json_extract(?, '$'))`,
            params: encodeD1Values([
              event.type === "UPDATE_APPLIED"
                ? event.to_bundle_id
                : event.from_bundle_id,
              event.received_at_ms,
              event.id,
              rowBytes,
            ]),
          },
        );
      }
      statements.push(liveUpsert(event, installKey));
    }
    statements.push({
      sql: `UPDATE ${SOURCE_STATE}
        SET backfill_after_received_at_ms = json_extract(?, '$'),
          backfill_after_id = json_extract(?, '$'),
          status = json_extract(?, '$')
        WHERE id = 1 AND version = 2 AND status = 'preparing'
          AND backfill_upper_received_at_ms = json_extract(?, '$')
          AND backfill_upper_id = json_extract(?, '$')
          AND backfill_after_received_at_ms IS json_extract(?, '$')
          AND backfill_after_id IS json_extract(?, '$')
        RETURNING status`,
      params: encodeD1Values([
        lastTime,
        last,
        ready ? "ready" : "preparing",
        upperTime,
        upper,
        afterTime,
        after,
      ]),
    });
    if (statements.length > 50) invalidResult();
    const results = await executor.batch(statements);
    if (
      results.length !== statements.length ||
      results.at(-1)?.length !== 1 ||
      allocationIndexes.some((index) => results[index]?.length !== 1)
    ) {
      invalidResult();
    }
    return { ready, processed: events.length };
  },
});
