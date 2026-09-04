import type {
  BundleEventRow,
  InsightsEventCursor,
  InsightsEventSelector,
  InsightsInstallationRow,
  InsightsModel,
} from "@hot-updater/plugin-core";

import type {
  ActiveInstallationWindow,
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
  readonly kind: "events";
  readonly selector: InsightsEventSelector;
  readonly version: 1;
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
    value.length > maximumLength
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

const sameSelector = (
  left: InsightsEventSelector,
  right: InsightsEventSelector,
): boolean =>
  left.kind === right.kind &&
  (left.kind === "all" ||
    (right.kind === "installationMovement" &&
      left.installId === right.installId));

const readEventCursor = (
  value: string,
  selector: InsightsEventSelector,
): EventCursorPayload => {
  const cursor = decodeCursor(value);
  if (
    !isRecord(cursor) ||
    cursor.version !== 1 ||
    cursor.kind !== "events" ||
    !isRecord(cursor.selector) ||
    !isRecord(cursor.after)
  ) {
    throw new InsightsBadRequestError("Invalid Insights cursor.");
  }
  const cursorSelector: InsightsEventSelector =
    cursor.selector.kind === "all"
      ? { kind: "all" }
      : cursor.selector.kind === "installationMovement"
        ? {
            kind: "installationMovement",
            installId: requireString(
              cursor.selector.installId,
              "install ID",
              MAX_IDENTITY_LENGTH,
            ),
          }
        : (() => {
            throw new InsightsBadRequestError("Invalid Insights cursor.");
          })();
  if (!sameSelector(cursorSelector, selector)) {
    throw new InsightsBadRequestError(
      "Insights cursor does not match the requested events.",
    );
  }
  return {
    after: {
      id: requireString(cursor.after.id, "event cursor", MAX_EVENT_ID_LENGTH),
      receivedAtMs: requireTimestamp(cursor.after.receivedAtMs, "event cursor"),
    },
    beforeReceivedAtMs: requireTimestamp(
      cursor.beforeReceivedAtMs,
      "event cutoff",
    ),
    kind: "events",
    selector: cursorSelector,
    version: 1,
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
  (right.id < left.id ? -1 : right.id > left.id ? 1 : 0);

const isAfterEventCursor = (
  row: BundleEventRow,
  after: InsightsEventCursor,
): boolean =>
  row.received_at_ms < after.receivedAtMs ||
  (row.received_at_ms === after.receivedAtMs && row.id < after.id);

const assertEventRows = (
  rows: readonly BundleEventRow[],
  input: {
    readonly after?: InsightsEventCursor;
    readonly beforeReceivedAtMs: number;
    readonly limit: number;
    readonly selector: InsightsEventSelector;
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
      !Number.isSafeInteger(row.received_at_ms) ||
      row.received_at_ms >= input.beforeReceivedAtMs ||
      (previous !== undefined && compareEventNewest(previous, row) >= 0) ||
      (input.after !== undefined && !isAfterEventCursor(row, input.after)) ||
      (input.selector.kind === "installationMovement" &&
        (row.install_id !== input.selector.installId ||
          (row.type !== "UPDATE_APPLIED" && row.type !== "RECOVERED")))
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
  selector: InsightsEventSelector,
  map: (row: BundleEventRow) => T,
) => {
  const limit = readLimit(input.limit);
  const cursor =
    input.cursor === undefined
      ? undefined
      : readEventCursor(input.cursor, selector);
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
  const databaseInput = {
    selector,
    beforeReceivedAtMs,
    ...(cursor === undefined ? {} : { after: cursor.after }),
    limit: limit + 1,
  };
  const rows = await model.pageEvents(databaseInput);
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
            selector,
            version: 1,
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
        row.install_id <= input.afterInstallId) ||
      (previous !== undefined && previous.install_id >= row.install_id)
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
      await model.append(createBundleEventRow(input));
    },
    pageEvents(input) {
      return pageEventRows(model, input, { kind: "all" }, toEventHistoryRow);
    },
    async pageInstallationEvents(input: InsightsInstallationEventPageInput) {
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
    async getInstallation(installId) {
      const normalizedInstallId = requireString(
        installId,
        "install ID",
        MAX_IDENTITY_LENGTH,
      );
      const row = await model.getInstallation(normalizedInstallId);
      if (row !== null && row.install_id !== normalizedInstallId) {
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
      const rows = await model.pageInstallationsByCurrentUserId(databaseInput);
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
    async getActiveInstallationOverview({ window }) {
      if (!(window in WINDOW_MS)) {
        throw new InsightsBadRequestError(
          "Invalid active installation window.",
        );
      }
      const asOfMs = Date.now();
      const activeInstallations = await model.countActiveInstallations({
        sinceMs: asOfMs - WINDOW_MS[window],
      });
      if (
        !Number.isSafeInteger(activeInstallations) ||
        activeInstallations < 0
      ) {
        throw new Error(
          "Insights database returned an invalid active installation count.",
        );
      }
      return { activeInstallations, asOfMs, window };
    },
  });
