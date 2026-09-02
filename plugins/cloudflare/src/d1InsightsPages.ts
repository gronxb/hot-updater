import {
  DatabasePluginInputError,
  InsightsQueryNotReadyError,
  type BundleEventRow,
  type InsightsEventPageData,
  type InsightsInstallationRow,
  type InsightsProjectedReadVersions,
  type InsightsSourceReadVersions,
  type InsightsLiveInstallationPage,
  type InsightsLiveInstallationPageInput,
  type InsightsLiveInstallationPageData,
  type InsightsPageEventsInput,
  type InsightsPageEventsResult,
} from "@hot-updater/plugin-core";
import {
  INSIGHTS_PAGE_MAX_BYTES,
  INSIGHTS_PAGE_MAX_ROWS,
  assertInsightsCursorContract,
  assertInsightsPageContract,
  assertInsightsQueryContract,
  getCanonicalInsightsJsonByteLength,
  isCanonicalInsightsEventId,
} from "@hot-updater/plugin-core/internal";

import type { D1Executor } from "./d1Implementation";
import {
  D1InsightsMigrationPoisonError,
  assertD1InsightsLayout,
  type D1InsightsEventPointer,
  d1InsightsInstallKey,
  readD1InsightsPointerEvents,
} from "./d1InsightsSource";
import { encodeD1Values } from "./d1Sql";

const SOURCE_EVENTS = "private_hot_updater_insights_source_events";
const INSTALLATION_EVENTS = "private_hot_updater_insights_installation_events";
const BUNDLE_EVENTS = "private_hot_updater_insights_bundle_events";
const LIVE_INSTALLATIONS = "private_hot_updater_insights_live_installations";
const SOURCE_INDEX = "private_hot_updater_insights_source_event_order_idx";
const INSTALLATION_INDEX =
  "private_hot_updater_insights_installation_event_order_idx";
const BUNDLE_INDEX = "private_hot_updater_insights_bundle_event_order_idx";
const INSTALL_KEY = /^[0-9a-f]{64}$/;
const MAX_INSTALLATION_CURSOR = 512;

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

const compareEventRows = (
  left: Pick<BundleEventRow, "received_at_ms" | "id">,
  right: Pick<BundleEventRow, "received_at_ms" | "id">,
): number =>
  right.received_at_ms - left.received_at_ms ||
  (left.id < right.id ? 1 : left.id > right.id ? -1 : 0);

const validateEventInput = (input: InsightsPageEventsInput): void => {
  try {
    assertInsightsQueryContract(input);
  } catch {
    invalidQuery();
  }
  if (
    !record(input) ||
    !record(input.selector) ||
    Object.keys(input).some(
      (key) =>
        ![
          "selector",
          "sinceReceivedAtMs",
          "beforeReceivedAtMs",
          "limit",
          "cursor",
        ].includes(key),
    )
  ) {
    invalidQuery();
  }
  const selector = input.selector;
  if (
    (selector.kind === "all" && Object.keys(selector).length === 1) ||
    (selector.kind === "installationId" &&
      typeof selector.installId === "string" &&
      Object.keys(selector).every((key) =>
        ["kind", "installId"].includes(key),
      )) ||
    (selector.kind === "bundleId" &&
      typeof selector.bundleId === "string" &&
      Object.keys(selector).every((key) => ["kind", "bundleId"].includes(key)))
  ) {
    return;
  }
  invalidQuery();
};

type ReadyState = {
  readonly sourceId: string;
  readonly generation: number;
};

const readySnapshot = (rows: readonly unknown[]): ReadyState => {
  if (rows.length === 0) throw new InsightsQueryNotReadyError();
  const first = rows[0];
  if (!record(first)) return invalidResult();
  if (first.source_status === "failed") {
    if (typeof first.source_id !== "string") return invalidResult();
    throw new D1InsightsMigrationPoisonError(first.source_id);
  }
  if (
    first.source_status !== "ready" ||
    typeof first.source_id !== "string" ||
    !/^[0-9a-f]{32}$/.test(first.source_id) ||
    !safeInteger(first.source_generation)
  ) {
    throw new InsightsQueryNotReadyError();
  }
  for (const row of rows) {
    if (
      !record(row) ||
      row.source_status !== "ready" ||
      row.source_id !== first.source_id ||
      row.source_generation !== first.source_generation
    ) {
      return invalidResult();
    }
  }
  return { sourceId: first.source_id, generation: first.source_generation };
};

const pointerRows = (rows: readonly unknown[]): readonly unknown[] => {
  if (rows.length === 1 && record(rows[0]) && rows[0].event_id === null) {
    return [];
  }
  if (rows.some((row) => !record(row) || row.event_id === null)) {
    return invalidResult();
  }
  return rows;
};

const sourceVersions = (state: ReadyState): InsightsSourceReadVersions => {
  const generation = JSON.stringify([2, state.sourceId, state.generation]);
  return {
    schemaVersion: "2",
    storageVersion: "d1-insights-v2",
    projectionGeneration: null,
    sourceGeneration: generation,
  };
};

const projectedVersions = (
  state: ReadyState,
): InsightsProjectedReadVersions => {
  const generation = JSON.stringify([2, state.sourceId, state.generation]);
  return {
    schemaVersion: "2",
    storageVersion: "d1-insights-v2",
    projectionGeneration: generation,
    sourceGeneration: generation,
  };
};

const pointer = (value: unknown): D1InsightsEventPointer => {
  if (!record(value)) return invalidResult();
  const eventId = value.event_id;
  const receivedAtMs = value.received_at_ms;
  const rowBytes = value.row_bytes;
  if (
    !isCanonicalInsightsEventId(eventId) ||
    !safeInteger(receivedAtMs) ||
    !safeInteger(rowBytes) ||
    rowBytes < 1
  ) {
    return invalidResult();
  }
  return { eventId, receivedAtMs, rowBytes };
};

const assertPointerOrder = (
  pointers: readonly D1InsightsEventPointer[],
): void => {
  for (let index = 1; index < pointers.length; index += 1) {
    const previous = pointers[index - 1]!;
    const current = pointers[index]!;
    if (
      compareEventRows(
        { id: previous.eventId, received_at_ms: previous.receivedAtMs },
        { id: current.eventId, received_at_ms: current.receivedAtMs },
      ) >= 0
    ) {
      invalidResult();
    }
  }
};

const eventSelectorKey = (input: InsightsPageEventsInput): string =>
  input.selector.kind === "all"
    ? "all"
    : input.selector.kind === "installationId"
      ? `installation:${input.selector.installId}`
      : `bundle:${input.selector.bundleId}`;

const readEventCursor = (
  input: InsightsPageEventsInput,
  databaseNamespace: string,
): { readonly receivedAtMs: number; readonly id: string } | undefined => {
  if (input.cursor === undefined) return undefined;
  try {
    assertInsightsCursorContract(input.cursor);
  } catch {
    return invalidQuery();
  }
  let value: unknown;
  try {
    value = JSON.parse(input.cursor);
  } catch {
    return invalidQuery();
  }
  if (
    !Array.isArray(value) ||
    value.length !== 7 ||
    value[0] !== 1 ||
    value[1] !== databaseNamespace ||
    value[2] !== eventSelectorKey(input) ||
    value[3] !== (input.sinceReceivedAtMs ?? 0) ||
    value[4] !== input.beforeReceivedAtMs ||
    !safeInteger(value[5]) ||
    value[5] < (input.sinceReceivedAtMs ?? 0) ||
    value[5] >= input.beforeReceivedAtMs ||
    !isCanonicalInsightsEventId(value[6])
  ) {
    return invalidQuery();
  }
  return { receivedAtMs: value[5], id: value[6] };
};

const createEventCursor = (
  input: InsightsPageEventsInput,
  databaseNamespace: string,
  row: Pick<BundleEventRow, "received_at_ms" | "id">,
): string => {
  const saved = JSON.stringify([
    1,
    databaseNamespace,
    eventSelectorKey(input),
    input.sinceReceivedAtMs ?? 0,
    input.beforeReceivedAtMs,
    row.received_at_ms,
    row.id,
  ]);
  try {
    assertInsightsCursorContract(saved);
  } catch {
    return invalidResult();
  }
  return saved;
};

const scopeStorage = (input: InsightsPageEventsInput) => {
  switch (input.selector.kind) {
    case "all":
      return {
        table: SOURCE_EVENTS,
        index: SOURCE_INDEX,
        filter: "",
        params: [] as readonly string[],
      };
    case "installationId":
      return {
        table: INSTALLATION_EVENTS,
        index: INSTALLATION_INDEX,
        filter: "install_id = json_extract(?, '$') AND ",
        params: encodeD1Values([input.selector.installId]),
      };
    case "bundleId":
      return {
        table: BUNDLE_EVENTS,
        index: BUNDLE_INDEX,
        filter: "bundle_id = json_extract(?, '$') AND ",
        params: encodeD1Values([input.selector.bundleId]),
      };
  }
};

const matchesScope = (
  input: InsightsPageEventsInput,
  event: BundleEventRow,
): boolean => {
  switch (input.selector.kind) {
    case "all":
      return true;
    case "installationId":
      return (
        event.install_id === input.selector.installId &&
        (event.type === "UPDATE_APPLIED" || event.type === "RECOVERED")
      );
    case "bundleId":
      return (
        (event.type === "UPDATE_APPLIED" &&
          event.to_bundle_id === input.selector.bundleId) ||
        (event.type === "RECOVERED" &&
          event.from_bundle_id === input.selector.bundleId)
      );
  }
};

const eventPageData = (
  input: InsightsPageEventsInput,
  pointers: readonly D1InsightsEventPointer[],
  rows: readonly BundleEventRow[],
  readVersions: InsightsSourceReadVersions,
  databaseNamespace: string,
): InsightsEventPageData => {
  const data = [...rows];
  for (;;) {
    const last = data.at(-1);
    const hasNext = pointers.length > data.length;
    const nextCursor =
      hasNext && last !== undefined
        ? createEventCursor(input, databaseNamespace, last)
        : null;
    const page: InsightsEventPageData = {
      data,
      nextCursor,
      hasNext,
      consistency: {
        kind: "live",
        cutoff: {
          kind: "event-time",
          beforeReceivedAtMs: input.beforeReceivedAtMs,
        },
      },
      total: { state: "unavailable" },
    };
    const result = {
      state: "ready",
      versions: readVersions,
      data: page,
    } as const;
    if (getCanonicalInsightsJsonByteLength(result) <= INSIGHTS_PAGE_MAX_BYTES) {
      assertInsightsPageContract(result, input.limit);
      return page;
    }
    if (data.length <= 1) invalidResult();
    data.pop();
  }
};

export const createD1InsightsEventPages = (
  executor: D1Executor,
  databaseNamespace: string,
) => ({
  async pageEvents(
    input: InsightsPageEventsInput,
  ): Promise<InsightsPageEventsResult> {
    validateEventInput(input);
    const cursor = readEventCursor(input, databaseNamespace);
    await assertD1InsightsLayout(executor);
    const storage = scopeStorage(input);
    const rows = await executor.query(
      `WITH source_state AS (
        SELECT source_id, status, generation
        FROM private_hot_updater_insights_source_state
        WHERE id = 1 AND version = 2
      ), page AS (
        SELECT event_id, received_at_ms, row_bytes
        FROM ${storage.table} INDEXED BY ${storage.index}
        WHERE ${storage.filter}received_at_ms >= json_extract(?, '$')
          AND received_at_ms < json_extract(?, '$')
          ${
            cursor === undefined
              ? ""
              : `AND (received_at_ms, event_id COLLATE BINARY) <
                (json_extract(?, '$'), json_extract(?, '$') COLLATE BINARY)`
          }
        ORDER BY received_at_ms DESC, event_id COLLATE BINARY DESC
        LIMIT json_extract(?, '$')
      )
      SELECT source.source_id, source.status AS source_status,
        source.generation AS source_generation, page.event_id,
        page.received_at_ms, page.row_bytes
      FROM source_state AS source LEFT JOIN page ON TRUE
      ORDER BY page.received_at_ms DESC, page.event_id COLLATE BINARY DESC`,
      [
        ...storage.params,
        ...encodeD1Values([
          input.sinceReceivedAtMs ?? 0,
          input.beforeReceivedAtMs,
          ...(cursor === undefined ? [] : [cursor.receivedAtMs, cursor.id]),
          input.limit + 1,
        ]),
      ],
    );
    if (rows.length > input.limit + 1) invalidResult();
    const state = readySnapshot(rows);
    const pointers = pointerRows(rows).map(pointer);
    assertPointerOrder(pointers);
    const selected = await readD1InsightsPointerEvents(
      executor,
      pointers,
      input.limit,
    );
    const events = selected.map(({ event, pointer: saved }) => {
      if (
        event.received_at_ms !== saved.receivedAtMs ||
        event.received_at_ms < (input.sinceReceivedAtMs ?? 0) ||
        event.received_at_ms >= input.beforeReceivedAtMs ||
        !matchesScope(input, event)
      ) {
        return invalidResult();
      }
      return event;
    });
    const readVersions = sourceVersions(state);
    return {
      state: "ready",
      versions: readVersions,
      data: eventPageData(
        input,
        pointers,
        events,
        readVersions,
        databaseNamespace,
      ),
    };
  },
});

type LivePointer = D1InsightsEventPointer & {
  readonly installKey: string;
};

const livePointer = (value: unknown): LivePointer => {
  const saved = pointer(value);
  if (!record(value)) return invalidResult();
  const installKey = value.install_key;
  if (typeof installKey !== "string" || !INSTALL_KEY.test(installKey)) {
    return invalidResult();
  }
  return { ...saved, installKey };
};

const installationRow = (event: BundleEventRow): InsightsInstallationRow => ({
  id: event.id,
  install_id: event.install_id,
  user_id: event.user_id,
  username: event.username,
  to_bundle_id: event.to_bundle_id,
  type: event.type,
  platform: event.platform,
  app_version: event.app_version,
  channel: event.channel,
  cohort: event.cohort,
  received_at_ms: event.received_at_ms,
});

const readAllCursor = (
  input: InsightsLiveInstallationPageInput & { readonly kind: "all" },
  databaseNamespace: string,
): { readonly sourceId: string; readonly installKey: string } | undefined => {
  if (input.cursor === undefined) return undefined;
  if (
    typeof input.cursor !== "string" ||
    input.cursor.length > MAX_INSTALLATION_CURSOR
  ) {
    return invalidQuery();
  }
  let value: unknown;
  try {
    value = JSON.parse(input.cursor);
  } catch {
    return invalidQuery();
  }
  if (
    !Array.isArray(value) ||
    value.length !== 5 ||
    value[0] !== 3 ||
    value[1] !== databaseNamespace ||
    typeof value[2] !== "string" ||
    !/^[0-9a-f]{32}$/.test(value[2]) ||
    value[3] !== "all" ||
    typeof value[4] !== "string" ||
    !INSTALL_KEY.test(value[4])
  ) {
    return invalidQuery();
  }
  return { sourceId: value[2], installKey: value[4] };
};

const validateInstallationInput = (
  input: InsightsLiveInstallationPageInput,
) => {
  try {
    assertInsightsQueryContract(input);
  } catch {
    invalidQuery();
  }
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    (input.kind !== "all" && input.kind !== "installationId") ||
    Object.keys(input).some(
      (key) =>
        !(
          input.kind === "all"
            ? ["kind", "limit", "cursor"]
            : ["kind", "installId", "limit", "cursor"]
        ).includes(key),
    ) ||
    (input.kind === "installationId" &&
      (!("installId" in input) || typeof input.installId !== "string")) ||
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > INSIGHTS_PAGE_MAX_ROWS
  ) {
    invalidQuery();
  }
};

const readLiveRows = async (
  executor: D1Executor,
  pointers: readonly LivePointer[],
  limit: number,
): Promise<readonly InsightsInstallationRow[]> => {
  const saved = await readD1InsightsPointerEvents(executor, pointers, limit);
  return Promise.all(
    saved.map(async ({ event, pointer: value }) => {
      if (
        event.id !== value.eventId ||
        (await d1InsightsInstallKey(event.install_id)) !== value.installKey
      ) {
        return invalidResult();
      }
      return installationRow(event);
    }),
  );
};

const installationPageData = (
  input: InsightsLiveInstallationPageInput,
  state: ReadyState,
  pointers: readonly LivePointer[],
  rows: readonly InsightsInstallationRow[],
  observedAtMs: number,
  readVersions: InsightsProjectedReadVersions,
  databaseNamespace: string,
): InsightsLiveInstallationPageData => {
  const data = [...rows];
  for (;;) {
    const last = pointers[data.length - 1];
    const hasNext = input.kind === "all" && pointers.length > data.length;
    const nextCursor =
      hasNext && last !== undefined
        ? JSON.stringify([
            3,
            databaseNamespace,
            state.sourceId,
            "all",
            last.installKey,
          ])
        : null;
    const page: InsightsLiveInstallationPageData = {
      data,
      nextCursor,
      hasNext,
      consistency: {
        kind: "live",
        cutoff: {
          kind: "projection",
          observedAtMs,
          projectionGeneration: projectedVersions(state).projectionGeneration,
        },
      },
      total: { state: "unavailable" },
    };
    const result = {
      state: "ready",
      versions: readVersions,
      data: page,
    } as const;
    if (getCanonicalInsightsJsonByteLength(result) <= INSIGHTS_PAGE_MAX_BYTES) {
      assertInsightsPageContract(result, input.limit);
      return page;
    }
    if (data.length <= 1) invalidResult();
    data.pop();
  }
};

export const createD1InsightsInstallationPages = (
  executor: D1Executor,
  now: () => number,
  databaseNamespace: string,
) => ({
  async pageInstallations(
    input: InsightsLiveInstallationPageInput,
  ): Promise<InsightsLiveInstallationPage> {
    validateInstallationInput(input);
    if (input.kind === "installationId" && input.cursor !== undefined) {
      invalidQuery();
    }
    const after =
      input.kind === "all"
        ? readAllCursor(input, databaseNamespace)
        : undefined;
    await assertD1InsightsLayout(executor);
    const observedAtMs = now();
    if (!safeInteger(observedAtMs)) invalidResult();
    let state: ReadyState;
    let pointers: readonly LivePointer[];
    let data: readonly InsightsInstallationRow[];
    if (input.kind === "all") {
      const rows = await executor.query(
        `WITH source_state AS (
          SELECT source_id, status, generation
          FROM private_hot_updater_insights_source_state
          WHERE id = 1 AND version = 2
        ), page AS (
          SELECT install_key, event_id, received_at_ms, row_bytes
          FROM ${LIVE_INSTALLATIONS}
          ${
            after === undefined
              ? ""
              : "WHERE install_key > json_extract(?, '$') COLLATE BINARY"
          }
          ORDER BY install_key COLLATE BINARY ASC
          LIMIT json_extract(?, '$')
        )
        SELECT source.source_id, source.status AS source_status,
          source.generation AS source_generation, page.install_key,
          page.event_id, page.received_at_ms, page.row_bytes
        FROM source_state AS source LEFT JOIN page ON TRUE
        ORDER BY page.install_key COLLATE BINARY ASC`,
        encodeD1Values([
          ...(after === undefined ? [] : [after.installKey]),
          input.limit + 1,
        ]),
      );
      if (rows.length > input.limit + 1) invalidResult();
      state = readySnapshot(rows);
      if (after !== undefined && after.sourceId !== state.sourceId) {
        invalidQuery();
      }
      pointers = pointerRows(rows).map(livePointer);
      if (
        pointers.some(
          (value, index) =>
            index > 0 && pointers[index - 1]!.installKey >= value.installKey,
        )
      ) {
        invalidResult();
      }
      data = await readLiveRows(executor, pointers, input.limit);
    } else {
      const installKey = await d1InsightsInstallKey(input.installId);
      const rows = await executor.query(
        `WITH source_state AS (
          SELECT source_id, status, generation
          FROM private_hot_updater_insights_source_state
          WHERE id = 1 AND version = 2
        ), page AS (
          SELECT install_key, event_id, received_at_ms, row_bytes
          FROM ${LIVE_INSTALLATIONS}
          WHERE install_key = json_extract(?, '$') COLLATE BINARY LIMIT 1
        )
        SELECT source.source_id, source.status AS source_status,
          source.generation AS source_generation, page.install_key,
          page.event_id, page.received_at_ms, page.row_bytes
        FROM source_state AS source LEFT JOIN page ON TRUE`,
        encodeD1Values([installKey]),
      );
      if (rows.length > 1) invalidResult();
      state = readySnapshot(rows);
      pointers = pointerRows(rows).map(livePointer);
      data = await readLiveRows(executor, pointers, 1);
      if (data[0] !== undefined && data[0].install_id !== input.installId) {
        invalidResult();
      }
    }
    const readVersions = projectedVersions(state);
    return {
      state: "ready",
      versions: readVersions,
      data: installationPageData(
        input,
        state,
        pointers,
        data,
        observedAtMs,
        readVersions,
        databaseNamespace,
      ),
    };
  },
});
