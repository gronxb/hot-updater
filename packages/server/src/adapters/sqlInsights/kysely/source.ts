import {
  DatabasePluginInputError,
  InsightsQueryNotReadyError,
  type BundleEventRow,
  type InsightsPageEventsInput,
  type InsightsPageEventsResult,
  type InsightsSourceReadVersions,
} from "@hot-updater/plugin-core";
import {
  assertInsightsCursorContract,
  assertInsightsEventContract,
  assertInsightsPageContract,
  canonicalInsightsJson,
  getCanonicalInsightsJsonByteLength,
  INSIGHTS_EVENT_MAX_BYTES,
  INSIGHTS_MAINTENANCE_INPUT_MAX_BYTES,
  INSIGHTS_PAGE_MAX_BYTES,
  INSIGHTS_PAGE_MAX_ROWS,
  isCanonicalInsightsEventId,
  readInsightsPageEventsInput,
} from "@hot-updater/plugin-core/internal";
import { sql, type Kysely, type QueryExecutorProvider } from "kysely";

import type { SQLProvider as KyselySQLProvider } from "../../kysely";
import { KYSELY_INSIGHTS_WORK_ROWS, tables } from "./constants";
import {
  executeSerializable,
  insertIgnore,
  installationKey,
  lockState,
  readRawEvent,
  sha256Hex,
  toSafeInteger,
} from "./utils";

type StateRow = {
  source_id: string;
  next_seq: unknown;
  ready: unknown;
  migration_upper_id: string | null;
  migration_after_id: string | null;
};

type StoredEvent = {
  event_id: string;
  source_seq: unknown;
  received_at_ms: unknown;
  install_key: string;
  install_id: string;
  raw_json: string;
};

const eventCursorRevision = "kysely-events-v1";

const isTimestamp = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const eventSelectorKey = (input: InsightsPageEventsInput): string => {
  switch (input.selector.kind) {
    case "all":
      return canonicalInsightsJson(["all"]);
    case "installationId":
      if (
        typeof input.selector.installId !== "string" ||
        input.selector.installId.length > 1_024 ||
        !input.selector.installId.isWellFormed()
      ) {
        throw new DatabasePluginInputError("invalid-query");
      }
      return canonicalInsightsJson([
        "installationId",
        input.selector.installId,
      ]);
    case "bundleId":
      if (!isCanonicalInsightsEventId(input.selector.bundleId)) {
        throw new DatabasePluginInputError("invalid-query");
      }
      return canonicalInsightsJson(["bundleId", input.selector.bundleId]);
  }
};

type EventCursor = {
  readonly sourceId: string;
  readonly receivedAtMs: number;
  readonly eventId: string;
};

const readEventCursor = (
  input: InsightsPageEventsInput,
  selectorKey: string,
): EventCursor | undefined => {
  if (input.cursor === undefined) return undefined;
  try {
    assertInsightsCursorContract(input.cursor);
  } catch {
    throw new DatabasePluginInputError("invalid-query");
  }
  let value: unknown;
  try {
    value = JSON.parse(input.cursor);
  } catch {
    throw new DatabasePluginInputError("invalid-query");
  }
  if (
    !Array.isArray(value) ||
    value.length !== 8 ||
    value[0] !== eventCursorRevision ||
    value[1] !== selectorKey ||
    value[2] !== input.beforeReceivedAtMs ||
    value[3] !== (input.sinceReceivedAtMs ?? 0) ||
    typeof value[4] !== "string" ||
    !isTimestamp(value[5]) ||
    value[5] < (input.sinceReceivedAtMs ?? 0) ||
    value[5] >= input.beforeReceivedAtMs ||
    !isCanonicalInsightsEventId(value[6]) ||
    value[7] !== "received-desc-id-desc"
  ) {
    throw new DatabasePluginInputError("invalid-query");
  }
  return {
    sourceId: value[4],
    receivedAtMs: value[5],
    eventId: value[6],
  };
};

const createEventCursor = (
  input: InsightsPageEventsInput,
  selectorKey: string,
  sourceId: string,
  row: Pick<BundleEventRow, "received_at_ms" | "id">,
): string => {
  const cursor = JSON.stringify([
    eventCursorRevision,
    selectorKey,
    input.beforeReceivedAtMs,
    input.sinceReceivedAtMs ?? 0,
    sourceId,
    row.received_at_ms,
    row.id,
    "received-desc-id-desc",
  ]);
  try {
    assertInsightsCursorContract(cursor);
  } catch {
    throw new DatabasePluginInputError("invalid-result");
  }
  return cursor;
};

const isReady = (value: unknown): boolean =>
  value === true || value === 1 || value === "1";

export const readKyselyInsightsState = async (
  db: QueryExecutorProvider,
  requireReady = true,
): Promise<{ sourceId: string; upper: number }> => {
  const result = await sql<StateRow>`select source_id, next_seq, ready,
    migration_upper_id, migration_after_id from ${sql.table(
      tables.state,
    )} where id = 1`.execute(db);
  const state = result.rows[0];
  if (!state || (requireReady && !isReady(state.ready))) {
    throw new InsightsQueryNotReadyError();
  }
  return { sourceId: state.source_id, upper: toSafeInteger(state.next_seq) };
};

const insertCoreEvent = async (
  db: QueryExecutorProvider,
  event: BundleEventRow,
): Promise<void> => {
  await sql`insert into bundle_events (
    id, type, install_id, user_id, username, from_release_id, from_bundle_id,
    to_release_id, to_bundle_id, platform, app_version, channel, cohort,
    update_strategy, fingerprint_hash, sdk_version, received_at_ms
  ) values (
    ${event.id}, ${event.type}, ${event.install_id}, ${event.user_id},
    ${event.username}, ${event.from_release_id}, ${event.from_bundle_id},
    ${event.to_release_id}, ${event.to_bundle_id}, ${event.platform},
    ${event.app_version}, ${event.channel}, ${event.cohort},
    ${event.update_strategy}, ${event.fingerprint_hash}, ${event.sdk_version},
    ${event.received_at_ms}
  )`.execute(db);
};

const saveAlias = async (
  db: QueryExecutorProvider,
  provider: KyselySQLProvider,
  sourceSeq: number,
  installKey: string,
  installId: string,
  kind: "install" | "user" | "username",
  value: string | null,
): Promise<void> => {
  if (value === null) return;
  const normalized = value.toLowerCase();
  await insertIgnore(db, provider, tables.aliases, {
    install_key: installKey,
    install_id: installId,
    alias_kind: kind,
    alias_hash: sha256Hex(JSON.stringify([kind, value])),
    value_json: JSON.stringify(value),
    normalized_json: JSON.stringify(normalized),
    source_seq: sourceSeq,
  });
};

const saveLive = async (
  db: QueryExecutorProvider,
  event: BundleEventRow,
  raw: string,
  sourceSeq: number,
  installKey: string,
): Promise<void> => {
  const current = await sql<{
    install_id: string;
    received_at_ms: unknown;
    event_id: string;
  }>`select install_id, received_at_ms, event_id from ${sql.table(
    tables.live,
  )} where install_key = ${installKey}`.execute(db);
  const row = current.rows[0];
  if (row && row.install_id !== event.install_id) {
    throw new DatabasePluginInputError("invalid-result");
  }
  const replaces =
    !row ||
    event.received_at_ms > toSafeInteger(row.received_at_ms) ||
    (event.received_at_ms === toSafeInteger(row.received_at_ms) &&
      event.id > row.event_id);
  if (!replaces) return;
  await sql`insert into ${sql.table(tables.liveVersions)}
    (install_key, source_seq, install_id, received_at_ms, event_id, raw_json)
    values (${installKey}, ${sourceSeq}, ${event.install_id},
      ${event.received_at_ms}, ${event.id}, ${raw})`.execute(db);
  if (!row) {
    await sql`insert into ${sql.table(tables.live)}
      (install_key, install_id, first_source_seq, received_at_ms, event_id,
        source_seq, raw_json)
      values (${installKey}, ${event.install_id}, ${sourceSeq},
        ${event.received_at_ms}, ${event.id}, ${sourceSeq}, ${raw})`.execute(
      db,
    );
    return;
  }
  await sql`update ${sql.table(tables.live)} set
      received_at_ms = ${event.received_at_ms}, event_id = ${event.id},
      source_seq = ${sourceSeq}, raw_json = ${raw}
    where install_key = ${installKey}`.execute(db);
};

const saveSourceEvent = async (
  db: QueryExecutorProvider,
  provider: KyselySQLProvider,
  event: BundleEventRow,
  insertCore: boolean,
): Promise<number> => {
  assertInsightsEventContract(event);
  const raw = canonicalInsightsJson(event);
  const key = await installationKey(event.install_id);
  await lockState(db, provider);
  const state = await readKyselyInsightsState(db, false);
  if (insertCore) await insertCoreEvent(db, event);
  const previous = await sql<{
    source_seq: unknown;
    raw_json: string;
  }>`select source_seq, raw_json from ${sql.table(
    tables.events,
  )} where event_id = ${event.id}`.execute(db);
  if (previous.rows[0]) {
    const stored = readRawEvent(previous.rows[0].raw_json);
    if (
      Object.entries(event).some(
        ([name, value]) => Reflect.get(stored, name) !== value,
      )
    ) {
      throw new DatabasePluginInputError("invalid-result");
    }
    return toSafeInteger(previous.rows[0].source_seq);
  }
  const sourceSeq = state.upper + 1;
  await sql`insert into ${sql.table(tables.events)}
    (event_id, source_seq, received_at_ms, install_key, install_id,
      event_type, to_bundle_id, from_bundle_id, raw_json)
    values (${event.id}, ${sourceSeq}, ${event.received_at_ms}, ${key},
      ${event.install_id}, ${event.type}, ${event.to_bundle_id},
      ${event.from_bundle_id}, ${raw})`.execute(db);
  await saveLive(db, event, raw, sourceSeq, key);
  await saveAlias(
    db,
    provider,
    sourceSeq,
    key,
    event.install_id,
    "install",
    event.install_id,
  );
  await saveAlias(
    db,
    provider,
    sourceSeq,
    key,
    event.install_id,
    "user",
    event.user_id,
  );
  await saveAlias(
    db,
    provider,
    sourceSeq,
    key,
    event.install_id,
    "username",
    event.username,
  );
  await sql`update ${sql.table(tables.state)} set next_seq = ${sourceSeq}
    where id = 1`.execute(db);
  return sourceSeq;
};

export const appendKyselyInsightsEvent = async <TDatabase>(
  db: Kysely<TDatabase>,
  provider: KyselySQLProvider,
  event: BundleEventRow,
): Promise<void> => {
  await executeSerializable(db, provider, (transaction) =>
    saveSourceEvent(transaction, provider, event, true),
  );
};

export const pageKyselyInsightsEvents = async (
  db: QueryExecutorProvider,
  input: InsightsPageEventsInput,
): Promise<InsightsPageEventsResult> => {
  input = readInsightsPageEventsInput(input);
  if (
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > INSIGHTS_PAGE_MAX_ROWS ||
    !isTimestamp(input.beforeReceivedAtMs) ||
    (input.sinceReceivedAtMs !== undefined &&
      !isTimestamp(input.sinceReceivedAtMs)) ||
    (input.sinceReceivedAtMs ?? 0) > input.beforeReceivedAtMs
  ) {
    throw new DatabasePluginInputError("invalid-query");
  }
  const selectorKey = eventSelectorKey(input);
  const cursor = readEventCursor(input, selectorKey);
  let currentSource: { sourceId: string; upper: number };
  try {
    currentSource = await readKyselyInsightsState(db);
  } catch (error) {
    if (!(error instanceof InsightsQueryNotReadyError)) throw error;
    return {
      state: "failed",
      versions: {
        schemaVersion: "1.0.0",
        storageVersion: "kysely-insights-1",
        projectionGeneration: null,
        sourceGeneration: null,
      },
      error: { code: "source-not-ready" },
    };
  }
  if (cursor !== undefined && cursor.sourceId !== currentSource.sourceId) {
    throw new DatabasePluginInputError("invalid-query");
  }
  const after = cursor
    ? sql`and (received_at_ms < ${cursor.receivedAtMs}
      or (received_at_ms = ${cursor.receivedAtMs} and event_id < ${cursor.eventId}))`
    : sql``;
  const readBranch = async (
    predicate: ReturnType<typeof sql>,
  ): Promise<readonly StoredEvent[]> =>
    (
      await sql<StoredEvent>`select event_id, source_seq,
          received_at_ms, install_key, install_id, raw_json
        from ${sql.table(tables.events)}
        where ${predicate}
          and received_at_ms >= ${input.sinceReceivedAtMs ?? 0}
          and received_at_ms < ${input.beforeReceivedAtMs}
          ${after}
        order by received_at_ms desc, event_id desc
        limit ${input.limit + 1}`.execute(db)
    ).rows;
  const selectedInstallKey =
    input.selector.kind === "installationId"
      ? await installationKey(input.selector.installId)
      : null;
  const branches: readonly (readonly StoredEvent[])[] =
    input.selector.kind === "all"
      ? [await readBranch(sql`1 = 1`)]
      : input.selector.kind === "installationId"
        ? [
            await readBranch(
              sql`install_key = ${selectedInstallKey}
                and event_type = 'UPDATE_APPLIED'`,
            ),
            await readBranch(
              sql`install_key = ${selectedInstallKey}
                and event_type = 'RECOVERED'`,
            ),
          ]
        : [
            await readBranch(
              sql`event_type = 'UPDATE_APPLIED'
                and to_bundle_id = ${input.selector.bundleId}`,
            ),
            await readBranch(
              sql`event_type = 'RECOVERED'
                and from_bundle_id = ${input.selector.bundleId}`,
            ),
          ];
  const candidates = branches
    .flat()
    .sort(
      (left, right) =>
        toSafeInteger(right.received_at_ms) -
          toSafeInteger(left.received_at_ms) ||
        (left.event_id < right.event_id
          ? 1
          : left.event_id > right.event_id
            ? -1
            : 0),
    )
    .slice(0, input.limit + 1);
  const readEvent = async (stored: StoredEvent): Promise<BundleEventRow> => {
    const event = readRawEvent(stored.raw_json);
    if (
      event.id !== stored.event_id ||
      event.install_id !== stored.install_id ||
      (await installationKey(event.install_id)) !== stored.install_key ||
      event.received_at_ms !== toSafeInteger(stored.received_at_ms)
    ) {
      throw new DatabasePluginInputError("invalid-result");
    }
    return event;
  };
  const sourceGeneration = JSON.stringify([
    "kysely-insights-1",
    currentSource.sourceId,
    currentSource.upper,
  ]);
  const versions: InsightsSourceReadVersions = {
    schemaVersion: "1.0.0" as const,
    storageVersion: "kysely-insights-1",
    projectionGeneration: null,
    sourceGeneration,
  };
  const buildResult = (
    rows: readonly BundleEventRow[],
    nextCursor: string | null,
  ) => ({
    state: "ready" as const,
    versions,
    data: {
      data: rows,
      nextCursor,
      hasNext: nextCursor !== null,
      consistency: {
        kind: "live" as const,
        cutoff: {
          kind: "event-time" as const,
          beforeReceivedAtMs: input.beforeReceivedAtMs,
        },
      },
      total: { state: "unavailable" as const },
    },
  });
  const rows: BundleEventRow[] = [];
  let lastScanned: BundleEventRow | undefined;
  let scannedCount = 0;
  for (const stored of candidates) {
    const event = await readEvent(stored);
    if (rows.length >= input.limit) break;
    const cursorCandidate = createEventCursor(
      input,
      selectorKey,
      currentSource.sourceId,
      event,
    );
    if (
      getCanonicalInsightsJsonByteLength(
        buildResult([...rows, event], cursorCandidate),
      ) > INSIGHTS_PAGE_MAX_BYTES
    ) {
      break;
    }
    rows.push(event);
    lastScanned = event;
    scannedCount += 1;
  }
  const hasMore =
    scannedCount < candidates.length || candidates.length === input.limit + 1;
  const nextCursor =
    hasMore && lastScanned
      ? createEventCursor(
          input,
          selectorKey,
          currentSource.sourceId,
          lastScanned,
        )
      : null;
  const result = buildResult(rows, nextCursor);
  assertInsightsPageContract(result, input.limit);
  return result;
};

type LegacyRow = BundleEventRow;
type LegacyId = { id: string };

export const prepareKyselyInsightsSource = async <TDatabase>(
  db: Kysely<TDatabase>,
  provider: KyselySQLProvider,
  limit = KYSELY_INSIGHTS_WORK_ROWS,
): Promise<{ state: "ready" | "progress"; processed: number }> => {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > KYSELY_INSIGHTS_WORK_ROWS
  ) {
    throw new DatabasePluginInputError("invalid-query");
  }
  const stateResult = await sql<StateRow>`select source_id, next_seq, ready,
      migration_upper_id, migration_after_id from ${sql.table(
        tables.state,
      )} where id = 1`.execute(db);
  const state = stateResult.rows[0];
  if (!state) throw new InsightsQueryNotReadyError();
  if (isReady(state.ready)) return { state: "ready", processed: 0 };
  if (!state.migration_upper_id) {
    throw new DatabasePluginInputError("invalid-result");
  }
  const after = state.migration_after_id
    ? sql`and id > ${state.migration_after_id}`
    : sql``;
  const page = await sql<LegacyId>`select id from bundle_events
    where id <= ${state.migration_upper_id} ${after}
    order by id asc limit ${limit}`.execute(db);
  const rows: LegacyRow[] = [];
  let bytes = 0;
  const potentiallyLargeFields = [
    "install_id",
    "user_id",
    "username",
    "platform",
    "app_version",
    "channel",
    "cohort",
    "update_strategy",
    "fingerprint_hash",
    "sdk_version",
  ];
  const byteLength = (field: string) =>
    provider === "sqlite"
      ? sql`length(cast(${sql.ref(field)} as blob))`
      : sql`octet_length(${sql.ref(field)})`;
  for (const candidate of page.rows) {
    try {
      const oversized = await sql<LegacyId>`select id from bundle_events
        where id = ${candidate.id} and (${sql.join(
          potentiallyLargeFields.map(
            (field) =>
              sql`coalesce(${byteLength(field)}, 0) > ${INSIGHTS_EVENT_MAX_BYTES}`,
          ),
          sql` or `,
        )}) limit 1`.execute(db);
      if (oversized.rows[0]) {
        throw new DatabasePluginInputError("invalid-result");
      }
      const result = await sql<LegacyRow>`select * from bundle_events
        where id = ${candidate.id}`.execute(db);
      const event = result.rows[0];
      if (!event) throw new DatabasePluginInputError("invalid-result");
      assertInsightsEventContract(event);
      const nextBytes = bytes + getCanonicalInsightsJsonByteLength(event);
      if (nextBytes > INSIGHTS_MAINTENANCE_INPUT_MAX_BYTES) break;
      rows.push(event);
      bytes = nextBytes;
    } catch (error) {
      await sql`update ${sql.table(tables.state)}
        set poison_event_id = ${candidate.id} where id = 1`.execute(db);
      throw error;
    }
  }
  for (const event of rows) {
    await executeSerializable(db, provider, async (transaction) => {
      await saveSourceEvent(transaction, provider, event, false);
      await sql`update ${sql.table(tables.state)}
        set migration_after_id = ${event.id}, poison_event_id = null
        where id = 1 and (migration_after_id is null
          or migration_after_id < ${event.id})`.execute(transaction);
    });
  }
  const last = rows.at(-1);
  const ready =
    rows.length === page.rows.length &&
    (page.rows.length < limit || last?.id === state.migration_upper_id);
  if (ready) {
    await executeSerializable(db, provider, async (transaction) => {
      await lockState(transaction, provider);
      await sql`update ${sql.table(tables.state)} set ready = ${
        provider === "sqlite" ? 1 : true
      }, poison_event_id = null where id = 1`.execute(transaction);
    });
  }
  return {
    state: ready ? "ready" : "progress",
    processed: rows.length,
  };
};
