import {
  DatabasePluginInputError,
  type BundleEventRow,
  type InsightsEventPage,
  type InsightsEventPageInput,
  type InsightsInstallationPage,
  type InsightsInstallationPageInput,
  type InsightsInstallationRow,
} from "@hot-updater/plugin-core";
import {
  compareInsightsEventRows,
  createInsightsEventPageCursor,
  readInsightsEventPageCursor,
} from "@hot-updater/plugin-core/internal";

import type { D1Executor } from "./d1Implementation";
import {
  assertD1InsightsReady,
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

const pointer = (value: unknown): D1InsightsEventPointer => {
  if (!record(value)) return invalidResult();
  const eventId = value.event_id;
  const receivedAtMs = value.received_at_ms;
  const rowBytes = value.row_bytes;
  if (
    typeof eventId !== "string" ||
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
      compareInsightsEventRows(
        { id: previous.eventId, received_at_ms: previous.receivedAtMs },
        { id: current.eventId, received_at_ms: current.receivedAtMs },
      ) >= 0
    ) {
      invalidResult();
    }
  }
};

const scopeStorage = (input: InsightsEventPageInput) => {
  switch (input.scope.kind) {
    case "all":
      return {
        table: SOURCE_EVENTS,
        index: SOURCE_INDEX,
        filter: "",
        params: [] as readonly string[],
      };
    case "installation":
      return {
        table: INSTALLATION_EVENTS,
        index: INSTALLATION_INDEX,
        filter: "install_id = json_extract(?, '$') AND ",
        params: encodeD1Values([input.scope.installId]),
      };
    case "bundle":
      return {
        table: BUNDLE_EVENTS,
        index: BUNDLE_INDEX,
        filter: "bundle_id = json_extract(?, '$') AND ",
        params: encodeD1Values([input.scope.bundleId]),
      };
  }
};

const matchesScope = (
  input: InsightsEventPageInput,
  event: BundleEventRow,
): boolean => {
  switch (input.scope.kind) {
    case "all":
      return true;
    case "installation":
      return (
        event.install_id === input.scope.installId &&
        (event.type === "UPDATE_APPLIED" || event.type === "RECOVERED")
      );
    case "bundle":
      return (
        (event.type === "UPDATE_APPLIED" &&
          event.to_bundle_id === input.scope.bundleId) ||
        (event.type === "RECOVERED" &&
          event.from_bundle_id === input.scope.bundleId)
      );
  }
};

export const createD1InsightsEventPages = (executor: D1Executor) => ({
  async pageEvents(input: InsightsEventPageInput): Promise<InsightsEventPage> {
    const cursor = readInsightsEventPageCursor(input);
    await assertD1InsightsReady(executor);
    const storage = scopeStorage(input);
    const rows = await executor.query(
      `SELECT event_id, received_at_ms, row_bytes
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
      LIMIT json_extract(?, '$')`,
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
    const pointers = rows.map(pointer);
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
    const last = events.at(-1);
    return {
      rows: events,
      nextCursor:
        pointers.length > events.length && last !== undefined
          ? createInsightsEventPageCursor(input, {
              id: last.id,
              receivedAtMs: last.received_at_ms,
            })
          : null,
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
  input: InsightsInstallationPageInput & { readonly kind: "all" },
  sourceId: string,
): string | undefined => {
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
    value.length !== 4 ||
    value[0] !== 2 ||
    value[1] !== sourceId ||
    value[2] !== "all" ||
    typeof value[3] !== "string" ||
    !INSTALL_KEY.test(value[3])
  ) {
    return invalidQuery();
  }
  return value[3];
};

const validateInstallationInput = (
  input: InsightsInstallationPageInput,
  kind: "all" | "installation",
) => {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    input.kind !== kind ||
    Object.keys(input).some(
      (key) =>
        !(
          kind === "all"
            ? ["kind", "limit", "cursor"]
            : ["kind", "installId", "limit", "cursor"]
        ).includes(key),
    ) ||
    (kind === "installation" &&
      (!("installId" in input) || typeof input.installId !== "string")) ||
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 100
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

export const createD1InsightsInstallationPages = (
  executor: D1Executor,
  now: () => number = Date.now,
) => ({
  async pageAll(
    input: InsightsInstallationPageInput & { readonly kind: "all" },
  ): Promise<InsightsInstallationPage> {
    validateInstallationInput(input, "all");
    const state = await assertD1InsightsReady(executor);
    const after = readAllCursor(input, state.sourceId);
    const rows = await executor.query(
      `SELECT install_key, event_id, received_at_ms, row_bytes
      FROM ${LIVE_INSTALLATIONS}
      ${
        after === undefined
          ? ""
          : "WHERE install_key > json_extract(?, '$') COLLATE BINARY"
      }
      ORDER BY install_key COLLATE BINARY ASC
      LIMIT json_extract(?, '$')`,
      encodeD1Values([
        ...(after === undefined ? [] : [after]),
        input.limit + 1,
      ]),
    );
    if (rows.length > input.limit + 1) invalidResult();
    const pointers = rows.map(livePointer);
    if (
      pointers.some(
        (value, index) =>
          index > 0 && pointers[index - 1]!.installKey >= value.installKey,
      )
    ) {
      invalidResult();
    }
    const data = await readLiveRows(executor, pointers, input.limit);
    const last = pointers[data.length - 1];
    const observedAtMs = now();
    if (!safeInteger(observedAtMs)) invalidResult();
    return {
      state: "ready",
      consistency: "live",
      observedAtMs,
      rows: data,
      nextCursor:
        pointers.length > data.length && last !== undefined
          ? JSON.stringify([2, state.sourceId, "all", last.installKey])
          : null,
    };
  },

  async pageInstallation(
    input: InsightsInstallationPageInput & {
      readonly kind: "installation";
    },
  ): Promise<InsightsInstallationPage> {
    validateInstallationInput(input, "installation");
    if (input.cursor !== undefined) invalidQuery();
    await assertD1InsightsReady(executor);
    const installKey = await d1InsightsInstallKey(input.installId);
    const rows = await executor.query(
      `SELECT install_key, event_id, received_at_ms, row_bytes
      FROM ${LIVE_INSTALLATIONS}
      WHERE install_key = json_extract(?, '$') COLLATE BINARY LIMIT 1`,
      encodeD1Values([installKey]),
    );
    if (rows.length > 1) invalidResult();
    const pointers = rows.map(livePointer);
    const data = await readLiveRows(executor, pointers, 1);
    if (data[0] !== undefined && data[0].install_id !== input.installId) {
      invalidResult();
    }
    const observedAtMs = now();
    if (!safeInteger(observedAtMs)) invalidResult();
    return {
      state: "ready",
      consistency: "live",
      observedAtMs,
      rows: data,
      nextCursor: null,
    };
  },
});
