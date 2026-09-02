import { createHash } from "node:crypto";

import {
  DatabasePluginInputError,
  type BundleEventRow,
  type InsightsInstallationRow,
  type InsightsPageEventsInput,
} from "@hot-updater/plugin-core";
import {
  INSIGHTS_CURSOR_MAX_BYTES,
  INSIGHTS_PAGE_MAX_BYTES,
  INSIGHTS_PAGE_MAX_ROWS,
  assertInsightsCursorContract,
  assertInsightsExpiredReadContract,
  assertInsightsFailedReadContract,
  assertInsightsPageContract,
  assertInsightsPreparingReadContract,
  assertInsightsEventContract,
  assertInsightsQueryContract,
  canonicalInsightsJson,
  getCanonicalInsightsJsonByteLength,
  isCanonicalInsightsEventId,
} from "@hot-updater/plugin-core/internal";

const identifierMaxCodeUnits = 1024;
const installCursorRevision = "prisma-live-sha256-json-v2";
const eventCursorRevision = "prisma-events-v2";
const namespaceIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function assertPrismaInsightsString(
  value: unknown,
  allowEmpty = false,
): asserts value is string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0) ||
    value.length > identifierMaxCodeUnits ||
    !value.isWellFormed()
  ) {
    throw new DatabasePluginInputError("invalid-query");
  }
}

export function assertPrismaInsightsLimit(
  value: unknown,
): asserts value is number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > INSIGHTS_PAGE_MAX_ROWS
  ) {
    throw new DatabasePluginInputError("invalid-query");
  }
}

export const prismaInsightsInstallKey = (installId: string): Buffer =>
  createHash("sha256").update(JSON.stringify(installId), "utf8").digest();

export const prismaInsightsEventOrder = (eventId: string): Buffer => {
  if (!isCanonicalInsightsEventId(eventId)) {
    throw new DatabasePluginInputError("invalid-result");
  }
  return Buffer.from(eventId.replaceAll("-", ""), "hex");
};

export type PrismaInsightsAliasKind = "install" | "user" | "username";

export interface PrismaInsightsAlias {
  readonly aliasKey: Buffer;
  readonly kind: PrismaInsightsAliasKind;
  readonly normalized: string;
  readonly original: string;
}

export const getPrismaInsightsAliases = (
  row: BundleEventRow,
): readonly PrismaInsightsAlias[] => {
  const values: readonly [PrismaInsightsAliasKind, string | null][] = [
    ["install", row.install_id],
    ["user", row.user_id],
    ["username", row.username],
  ];
  return values.flatMap(([kind, original]) => {
    if (original === null) return [];
    const normalized = original.toLowerCase();
    return [
      {
        aliasKey: createHash("sha256")
          .update(canonicalInsightsJson([kind, normalized, row.install_id]))
          .digest(),
        kind,
        normalized,
        original,
      },
    ];
  });
};

export const parsePrismaInsightsEventJson = (
  value: unknown,
): BundleEventRow => {
  if (typeof value !== "string") {
    throw new DatabasePluginInputError("invalid-result");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new DatabasePluginInputError("invalid-result");
  }
  try {
    assertInsightsEventContract(parsed);
  } catch {
    throw new DatabasePluginInputError("invalid-result");
  }
  return parsed;
};

export const toPrismaInsightsInstallationRow = (
  event: BundleEventRow,
): InsightsInstallationRow => ({
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

interface InstallationCursor {
  readonly sourceId: string;
  readonly installKey: Buffer;
}

export const readPrismaInsightsInstallationCursor = (input: {
  readonly kind: "all";
  readonly cursor?: string;
}): InstallationCursor | undefined => {
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
    value.length !== 4 ||
    value[0] !== installCursorRevision ||
    value[1] !== "all" ||
    typeof value[2] !== "string" ||
    !namespaceIdPattern.test(value[2]) ||
    typeof value[3] !== "string" ||
    !/^[0-9a-f]{64}$/.test(value[3])
  ) {
    throw new DatabasePluginInputError("invalid-query");
  }
  return { sourceId: value[2], installKey: Buffer.from(value[3], "hex") };
};

export const createPrismaInsightsInstallationCursor = (
  sourceId: string,
  installKey: Buffer,
): string => {
  if (!namespaceIdPattern.test(sourceId))
    throw new DatabasePluginInputError("invalid-result");
  const cursor = JSON.stringify([
    installCursorRevision,
    "all",
    sourceId,
    installKey.toString("hex"),
  ]);
  if (Buffer.byteLength(cursor, "utf8") > INSIGHTS_CURSOR_MAX_BYTES) {
    throw new DatabasePluginInputError("invalid-result");
  }
  return cursor;
};

const eventSelectorKey = (input: InsightsPageEventsInput): string => {
  switch (input.selector.kind) {
    case "all":
      return canonicalInsightsJson(["all"]);
    case "installationId":
      assertPrismaInsightsString(input.selector.installId, true);
      return canonicalInsightsJson([
        "installationId",
        input.selector.installId,
      ]);
    case "bundleId":
      assertPrismaInsightsString(input.selector.bundleId);
      return canonicalInsightsJson(["bundleId", input.selector.bundleId]);
  }
};

export interface PrismaInsightsEventCursor {
  readonly sourceId: string;
  readonly receivedAtMs: number;
  readonly id: string;
}

const isTimestamp = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export const readPrismaInsightsEventCursor = (
  input: InsightsPageEventsInput,
): PrismaInsightsEventCursor | undefined => {
  assertPrismaInsightsLimit(input.limit);
  if (
    !isTimestamp(input.beforeReceivedAtMs) ||
    (input.sinceReceivedAtMs !== undefined &&
      !isTimestamp(input.sinceReceivedAtMs)) ||
    (input.sinceReceivedAtMs ?? 0) > input.beforeReceivedAtMs
  ) {
    throw new DatabasePluginInputError("invalid-query");
  }
  const selector = eventSelectorKey(input);
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
    value[1] !== selector ||
    value[2] !== input.beforeReceivedAtMs ||
    value[3] !== (input.sinceReceivedAtMs ?? 0) ||
    typeof value[4] !== "string" ||
    !namespaceIdPattern.test(value[4]) ||
    !isTimestamp(value[5]) ||
    value[5] < (input.sinceReceivedAtMs ?? 0) ||
    value[5] >= input.beforeReceivedAtMs ||
    typeof value[6] !== "string" ||
    value[7] !== "received-desc-id-desc"
  ) {
    throw new DatabasePluginInputError("invalid-query");
  }
  if (!isCanonicalInsightsEventId(value[6])) {
    throw new DatabasePluginInputError("invalid-query");
  }
  return { sourceId: value[4], receivedAtMs: value[5], id: value[6] };
};

export const createPrismaInsightsEventCursor = (
  input: InsightsPageEventsInput,
  sourceId: string,
  row: Pick<BundleEventRow, "received_at_ms" | "id">,
): string => {
  if (!namespaceIdPattern.test(sourceId))
    throw new DatabasePluginInputError("invalid-result");
  const cursor = JSON.stringify([
    eventCursorRevision,
    eventSelectorKey(input),
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

export const assertPrismaInsightsQuery = (value: unknown): void => {
  try {
    assertInsightsQueryContract(value);
  } catch {
    throw new DatabasePluginInputError("invalid-query");
  }
};

export const validatedPrismaInsightsPageResult = <TResult>(
  value: TResult,
  requestedLimit: number,
): TResult => {
  if (typeof value !== "object" || value === null)
    throw new DatabasePluginInputError("invalid-result");
  const state = Reflect.get(value, "state");
  if (state === "ready" || state === "stale")
    assertInsightsPageContract(value, requestedLimit);
  else if (state === "preparing") assertInsightsPreparingReadContract(value);
  else if (state === "failed") assertInsightsFailedReadContract(value);
  else if (state === "expired") assertInsightsExpiredReadContract(value);
  else throw new DatabasePluginInputError("invalid-result");
  return value;
};

/**
 * Returns the longest nonempty prefix fitting the complete public envelope.
 * Raw events are at most 20 KiB, so one valid row always makes progress.
 */
export const takePrismaInsightsPageRows = <TRow>(
  candidates: readonly TRow[],
  requestedLimit: number,
  envelope: (rows: readonly TRow[], nextCursor: string | null) => unknown,
  cursorFor: (row: TRow) => string,
): { readonly rows: readonly TRow[]; readonly nextCursor: string | null } => {
  const upper = Math.min(requestedLimit, candidates.length);
  const rows: TRow[] = [];
  for (let index = 0; index < upper; index += 1) {
    const row = candidates[index];
    if (row === undefined) break;
    const nextRows = [...rows, row];
    const hasMore = index + 1 < candidates.length;
    const nextCursor = hasMore ? cursorFor(row) : null;
    if (
      getCanonicalInsightsJsonByteLength(envelope(nextRows, nextCursor)) >
      INSIGHTS_PAGE_MAX_BYTES
    ) {
      break;
    }
    rows.push(row);
  }
  if (rows.length === 0 && candidates.length > 0) {
    throw new DatabasePluginInputError("invalid-result");
  }
  const hasMore = rows.length < candidates.length;
  const last = rows.at(-1);
  return {
    rows,
    nextCursor: hasMore && last !== undefined ? cursorFor(last) : null,
  };
};
