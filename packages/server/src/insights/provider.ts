import {
  compareInsightsText,
  isInsightsMovementEvent,
  isUUIDv7,
  toInsightsInstallationRow,
  type InsightsBundleEventFilter,
  type BundleEventRow,
  type InsightsEventCursor,
  type InsightsEventFilter,
  type InsightsInstallationRow,
  type InsightsModel,
} from "@hot-updater/plugin-core";

import type {
  ActiveInstallationWindow,
  InsightsBundleSelection,
  InsightsScope,
  EventHistoryRow,
  InstallationHistoryRow,
  InstallationRow,
} from "./domain";
import { InsightsBadRequestError } from "./errors";
import { createBundleEventRow } from "./eventInput";
import type {
  InsightsEventPageInput,
  InsightsInstallationEventPageInput,
  InsightsProvider,
  InsightsUserInstallationPageInput,
} from "./types";

const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 100;
const MAX_EVENT_ID_LENGTH = 1_024;
const MAX_IDENTITY_LENGTH = 255;
const MAX_CURSOR_LENGTH = 8 * 1_024;

const WINDOW_MS: Record<ActiveInstallationWindow, number> = {
  "24h": 24 * 60 * 60 * 1_000,
  "7d": 7 * 24 * 60 * 60 * 1_000,
  "30d": 30 * 24 * 60 * 60 * 1_000,
};

type EventCursorPayload = {
  readonly after: InsightsEventCursor;
  readonly beforeReceivedAtMs: number;
  readonly sinceMs: number;
  readonly kind: "events";
  readonly filter: InsightsEventFilter;
  readonly version: 2;
};

type UserInstallationCursorPayload = {
  readonly afterInstallId: string;
  readonly kind: "user-installations";
  readonly userId: string;
  readonly version: 1;
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const requireString = (
  value: unknown,
  label: string,
  maximumLength: number,
): string => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumLength ||
    new TextDecoder("utf-8", { ignoreBOM: true }).decode(
      new TextEncoder().encode(value),
    ) !== value
  ) {
    throw new InsightsBadRequestError(`Invalid ${label}.`);
  }
  return value;
};

const requireTimestamp = (value: unknown, label: string): number => {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new InsightsBadRequestError(`Invalid ${label}.`);
  }
  return Number(value);
};

const readLimit = (value: number | undefined): number => {
  const limit = value ?? DEFAULT_PAGE_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) {
    throw new InsightsBadRequestError("Invalid page limit.");
  }
  return limit;
};

const encodeBase64Url = (value: string): string => {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
};

const decodeBase64Url = (value: string): string => {
  if (value.length === 0 || value.length > MAX_CURSOR_LENGTH) {
    throw new InsightsBadRequestError("Invalid Insights cursor.");
  }
  try {
    const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0),
    );
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new InsightsBadRequestError("Invalid Insights cursor.");
  }
};

const encodeCursor = (
  value: EventCursorPayload | UserInstallationCursorPayload,
): string => encodeBase64Url(JSON.stringify(value));

const decodeCursor = (value: string): unknown => {
  try {
    return JSON.parse(decodeBase64Url(value));
  } catch (error) {
    if (error instanceof InsightsBadRequestError) throw error;
    throw new InsightsBadRequestError("Invalid Insights cursor.");
  }
};

const readScope = (input: InsightsScope): InsightsScope => {
  if (input.platform !== "ios" && input.platform !== "android") {
    throw new InsightsBadRequestError("Invalid Insights platform.");
  }
  return {
    platform: input.platform,
    channel: requireString(input.channel, "channel", MAX_EVENT_ID_LENGTH),
  };
};

// Counts and drill-downs share the exact same raw predicate.
const bundleFilter = (
  input: InsightsBundleSelection,
): InsightsBundleEventFilter => {
  const scope = readScope(input);
  const bundleId = requireString(
    input.bundleId,
    "bundle ID",
    MAX_EVENT_ID_LENGTH,
  );
  switch (input.outcome) {
    case "applied":
      return { ...scope, type: "UPDATE_APPLIED", toBundleId: bundleId };
    case "recovered":
      return { ...scope, type: "RECOVERED", fromBundleId: bundleId };
    case "adopted":
      return { ...scope, type: "RELEASE_ADOPTED", toBundleId: bundleId };
    default:
      throw new InsightsBadRequestError("Invalid Insights outcome.");
  }
};

const sameFilter = (left: unknown, right: InsightsEventFilter): boolean => {
  if (!isRecord(left) || left.kind !== right.kind) return false;
  switch (right.kind) {
    case "all":
      return true;
    case "installationMovement":
      return left.installId === right.installId;
    case "bundle":
      return (
        left.platform === right.platform &&
        left.channel === right.channel &&
        left.type === right.type &&
        (right.type === "RECOVERED"
          ? left.fromBundleId === right.fromBundleId
          : left.toBundleId === right.toBundleId)
      );
  }
};

const readEventCursor = (
  value: string,
  filter: InsightsEventFilter,
): EventCursorPayload => {
  const cursor = decodeCursor(value);
  if (
    !isRecord(cursor) ||
    cursor.version !== 2 ||
    cursor.kind !== "events" ||
    !isRecord(cursor.filter) ||
    !isRecord(cursor.after)
  ) {
    throw new InsightsBadRequestError("Invalid Insights cursor.");
  }
  if (!sameFilter(cursor.filter, filter)) {
    throw new InsightsBadRequestError(
      "Insights cursor does not match the requested events.",
    );
  }
  if (typeof cursor.after.id !== "string" || !isUUIDv7(cursor.after.id)) {
    throw new InsightsBadRequestError("Invalid Insights event cursor ID.");
  }
  return {
    after: {
      id: cursor.after.id,
      receivedAtMs: requireTimestamp(cursor.after.receivedAtMs, "event cursor"),
    },
    beforeReceivedAtMs: requireTimestamp(
      cursor.beforeReceivedAtMs,
      "event cutoff",
    ),
    kind: "events",
    sinceMs: requireTimestamp(cursor.sinceMs, "event start"),
    filter,
    version: 2,
  };
};

const readUserInstallationCursor = (
  value: string,
  userId: string,
): UserInstallationCursorPayload => {
  const cursor = decodeCursor(value);
  if (
    !isRecord(cursor) ||
    cursor.version !== 1 ||
    cursor.kind !== "user-installations" ||
    cursor.userId !== userId
  ) {
    throw new InsightsBadRequestError(
      "Insights cursor does not match the requested user ID.",
    );
  }
  return {
    afterInstallId: requireString(
      cursor.afterInstallId,
      "installation cursor",
      MAX_IDENTITY_LENGTH,
    ),
    kind: "user-installations",
    userId,
    version: 1,
  };
};

const compareEventNewest = (
  left: Pick<BundleEventRow, "id" | "received_at_ms">,
  right: Pick<BundleEventRow, "id" | "received_at_ms">,
): number =>
  right.received_at_ms - left.received_at_ms ||
  compareInsightsText(right.id, left.id);

const isAfterEventCursor = (
  row: BundleEventRow,
  after: InsightsEventCursor,
): boolean =>
  row.received_at_ms < after.receivedAtMs ||
  (row.received_at_ms === after.receivedAtMs &&
    compareInsightsText(row.id, after.id) < 0);

const assertEventRows = (
  rows: readonly BundleEventRow[],
  input: {
    readonly after?: InsightsEventCursor;
    readonly beforeReceivedAtMs: number;
    readonly limit: number;
    readonly filter: InsightsEventFilter;
    readonly sinceMs: number;
  },
): void => {
  if (rows.length > input.limit) {
    throw new Error("Insights database returned too many event rows.");
  }
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const previous = rows[index - 1];
    if (
      !row ||
      typeof row.id !== "string" ||
      !isUUIDv7(row.id) ||
      !Number.isSafeInteger(row.received_at_ms) ||
      row.received_at_ms >= input.beforeReceivedAtMs ||
      row.received_at_ms < input.sinceMs ||
      (previous !== undefined && compareEventNewest(previous, row) >= 0) ||
      (input.after !== undefined && !isAfterEventCursor(row, input.after)) ||
      (input.filter.kind === "installationMovement" &&
        (row.install_id !== input.filter.installId ||
          !isInsightsMovementEvent(row))) ||
      (input.filter.kind === "bundle" &&
        (row.platform !== input.filter.platform ||
          row.channel !== input.filter.channel ||
          row.type !== input.filter.type ||
          (input.filter.type === "RECOVERED"
            ? row.from_bundle_id !== input.filter.fromBundleId
            : row.to_bundle_id !== input.filter.toBundleId)))
    ) {
      throw new Error("Insights database returned invalid event rows.");
    }
  }
};

const toEventHistoryRow = (row: BundleEventRow): EventHistoryRow => ({
  appVersion: row.app_version,
  channel: row.channel,
  cohort: row.cohort,
  fromBundleId: row.from_bundle_id,
  id: row.id,
  installId: row.install_id,
  platform: row.platform,
  receivedAtMs: row.received_at_ms,
  toBundleId: row.to_bundle_id,
  type: row.type,
  userId: row.user_id,
  username: row.username,
});

const toInstallationRow = (row: InsightsInstallationRow): InstallationRow => ({
  appVersion: row.app_version,
  channel: row.channel,
  cohort: row.cohort,
  installId: row.install_id,
  lastKnownBundleId: row.to_bundle_id,
  latestStatus: row.type,
  platform: row.platform,
  receivedAtMs: row.received_at_ms,
  userId: row.user_id,
  username: row.username,
});

const pageEventRows = async <T extends EventHistoryRow>(
  model: InsightsModel,
  input: InsightsEventPageInput,
  filter: InsightsEventFilter,
  map: (row: BundleEventRow) => T,
) => {
  const limit = readLimit(input.limit);
  const cursor =
    input.cursor === undefined
      ? undefined
      : readEventCursor(input.cursor, filter);
  const beforeReceivedAtMs =
    cursor?.beforeReceivedAtMs ??
    (input.beforeReceivedAtMs === undefined
      ? Date.now()
      : requireTimestamp(input.beforeReceivedAtMs, "event cutoff"));
  if (
    cursor !== undefined &&
    input.beforeReceivedAtMs !== undefined &&
    input.beforeReceivedAtMs !== beforeReceivedAtMs
  ) {
    throw new InsightsBadRequestError(
      "Insights cursor does not match the requested event cutoff.",
    );
  }
  const sinceMs =
    cursor?.sinceMs ??
    (input.sinceMs === undefined
      ? 0
      : requireTimestamp(input.sinceMs, "event start"));
  if (
    sinceMs > beforeReceivedAtMs ||
    (input.sinceMs !== undefined && input.sinceMs !== sinceMs) ||
    (cursor !== undefined &&
      (cursor.after.receivedAtMs < sinceMs ||
        cursor.after.receivedAtMs >= beforeReceivedAtMs))
  ) {
    throw new InsightsBadRequestError(
      "Insights cursor or range does not match the requested event start.",
    );
  }
  const databaseInput = {
    filter,
    sinceMs,
    beforeReceivedAtMs,
    ...(cursor === undefined ? {} : { after: cursor.after }),
    limit: limit + 1,
  };
  const rows = await model.listEvents(databaseInput);
  assertEventRows(rows, databaseInput);
  const pageRows = rows.slice(0, limit);
  const last = pageRows.at(-1);
  return {
    beforeReceivedAtMs,
    data: pageRows.map(map),
    nextCursor:
      rows.length > limit && last
        ? encodeCursor({
            after: { id: last.id, receivedAtMs: last.received_at_ms },
            beforeReceivedAtMs,
            kind: "events",
            filter,
            sinceMs,
            version: 2,
          })
        : null,
  };
};

const assertInstallationRows = (
  rows: readonly InsightsInstallationRow[],
  input: {
    readonly afterInstallId?: string;
    readonly limit: number;
    readonly userId: string;
  },
): void => {
  if (rows.length > input.limit) {
    throw new Error("Insights database returned too many installation rows.");
  }
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const previous = rows[index - 1];
    if (
      !row ||
      row.user_id !== input.userId ||
      (input.afterInstallId !== undefined &&
        compareInsightsText(row.install_id, input.afterInstallId) <= 0) ||
      (previous !== undefined &&
        compareInsightsText(previous.install_id, row.install_id) >= 0)
    ) {
      throw new Error("Insights database returned invalid installation rows.");
    }
  }
};

export const createInsightsProvider = (
  model: InsightsModel,
): InsightsProvider =>
  Object.freeze({
    async appendBundleEvent(input) {
      const event = createBundleEventRow(input);
      await model.record({
        event,
        installation: toInsightsInstallationRow(event),
      });
    },
    listEvents(input) {
      const filter: InsightsEventFilter =
        input.bundle === undefined
          ? { kind: "all" }
          : { kind: "bundle", ...bundleFilter(input.bundle) };
      return pageEventRows(model, input, filter, toEventHistoryRow);
    },
    async listInstallationEvents(input: InsightsInstallationEventPageInput) {
      if ("bundle" in input && input.bundle !== undefined) {
        throw new InsightsBadRequestError(
          "Installation movement queries cannot include a bundle filter.",
        );
      }
      const installId = requireString(
        input.installId,
        "install ID",
        MAX_IDENTITY_LENGTH,
      );
      return pageEventRows(
        model,
        input,
        { kind: "installationMovement", installId },
        (row) => toEventHistoryRow(row) as InstallationHistoryRow,
      );
    },
    async getInstallation({ installId }) {
      const normalizedInstallId = requireString(
        installId,
        "install ID",
        MAX_IDENTITY_LENGTH,
      );
      const rows = await model.findInstallations({
        installId: normalizedInstallId,
      });
      const row = rows[0] ?? null;
      if (
        rows.length > 1 ||
        (row !== null && row.install_id !== normalizedInstallId)
      ) {
        throw new Error("Insights database returned an invalid installation.");
      }
      return row === null ? null : toInstallationRow(row);
    },
    async pageInstallationsByCurrentUserId(
      input: InsightsUserInstallationPageInput,
    ) {
      const userId = requireString(
        input.userId,
        "user ID",
        MAX_IDENTITY_LENGTH,
      );
      const limit = readLimit(input.limit);
      const cursor =
        input.cursor === undefined
          ? undefined
          : readUserInstallationCursor(input.cursor, userId);
      const databaseInput = {
        userId,
        ...(cursor === undefined
          ? {}
          : { afterInstallId: cursor.afterInstallId }),
        limit: limit + 1,
      };
      const rows = await model.findInstallations(databaseInput);
      assertInstallationRows(rows, databaseInput);
      const pageRows = rows.slice(0, limit);
      const last = pageRows.at(-1);
      return {
        data: pageRows.map(toInstallationRow),
        nextCursor:
          rows.length > limit && last
            ? encodeCursor({
                afterInstallId: last.install_id,
                kind: "user-installations",
                userId,
                version: 1,
              })
            : null,
      };
    },
    async getReportingOverview(input) {
      const scope = readScope(input);
      const { window } = input;
      if (!Object.hasOwn(WINDOW_MS, window)) {
        throw new InsightsBadRequestError(
          "Invalid reporting installation window.",
        );
      }
      const beforeReceivedAtMs = Date.now();
      const sinceMs = Math.max(0, beforeReceivedAtMs - WINDOW_MS[window]);
      const measure = async (count: Promise<number>) => {
        const value = await count;
        if (!Number.isSafeInteger(value) || value < 0) {
          throw new Error("Insights database returned an invalid count.");
        }
        return { count: value, measuredAtMs: Date.now() };
      };
      const bundleId =
        input.bundleId === undefined
          ? undefined
          : requireString(input.bundleId, "bundle ID", MAX_EVENT_ID_LENGTH);
      const reporting = measure(
        model.countInstallations({ ...scope, sinceMs }),
      );
      if (bundleId === undefined) {
        return {
          ...scope,
          window,
          sinceMs,
          beforeReceivedAtMs,
          reportingInstallations: await reporting,
        };
      }
      const countOutcome = (outcome: InsightsBundleSelection["outcome"]) =>
        measure(
          model.countEvents({
            filter: bundleFilter({ ...scope, bundleId, outcome }),
            sinceMs,
            beforeReceivedAtMs,
          }),
        );
      const [
        reportingInstallations,
        bundleInstallations,
        appliedReports,
        recoveredReports,
        adoptedReports,
      ] = await Promise.all([
        reporting,
        measure(model.countInstallations({ ...scope, sinceMs, bundleId })),
        countOutcome("applied"),
        countOutcome("recovered"),
        countOutcome("adopted"),
      ]);
      return {
        ...scope,
        window,
        sinceMs,
        beforeReceivedAtMs,
        reportingInstallations,
        bundle: {
          bundleId,
          reportingInstallations: bundleInstallations,
          appliedReports,
          recoveredReports,
          adoptedReports,
        },
      };
    },
  });
