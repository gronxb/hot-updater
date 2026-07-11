import type { Platform } from "@hot-updater/core";
import type { DatabaseBundleEventInput } from "@hot-updater/plugin-core";

export const UNSUPPORTED_BUNDLE_EVENTS_MESSAGE =
  "Bundle events are not supported by this database provider.";

export const DEFAULT_BUNDLE_EVENT_MAX_BODY_BYTES = 16 * 1024;
export const MAX_BUNDLE_EVENT_FUTURE_SKEW_MS = 5 * 60 * 1000;

const MAX_PERSISTED_STRING_LENGTH = 1024;
const PERSISTED_STRING_FIELDS = [
  "activeBundleId",
  "previousActiveBundleId",
  "crashedBundleId",
  "installId",
  "channel",
  "appVersion",
  "fingerprintHash",
  "cohort",
  "userId",
  "defaultChannel",
  "sdkVersion",
] as const;
const UUID_V7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type ReadBundleEventBodyResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly reason: "invalid" | "too-large" };

export const readBundleEventBody = async (
  request: Request,
  maxBodyBytes: number,
): Promise<ReadBundleEventBodyResult> => {
  const contentLength = request.headers.get("Content-Length");
  if (
    contentLength !== null &&
    Number.isFinite(Number(contentLength)) &&
    Number(contentLength) > maxBodyBytes
  ) {
    return { ok: false, reason: "too-large" };
  }

  if (!request.body) {
    return { ok: false, reason: "invalid" };
  }

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let byteLength = 0;
  let text = "";

  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        text += decoder.decode();
        break;
      }

      byteLength += result.value.byteLength;
      if (byteLength > maxBodyBytes) {
        await reader.cancel();
        return { ok: false, reason: "too-large" };
      }
      text += decoder.decode(result.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }

  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, reason: "invalid" };
  }
};

export const isUUIDv7 = (value: string): boolean => UUID_V7_PATTERN.test(value);

export const createRetentionBoundaryId = (
  serverTimestamp: number,
  maxAgeMs: number,
): string => {
  const boundaryTimestamp = Math.max(0, serverTimestamp - maxAgeMs);
  const boundaryHex = Math.trunc(boundaryTimestamp)
    .toString(16)
    .padStart(12, "0");

  return `${boundaryHex.slice(0, 8)}-${boundaryHex.slice(
    8,
  )}-7000-8000-000000000000`;
};

type ParseAppReadyBundleEventResult =
  | {
      readonly ok: true;
      readonly event: DatabaseBundleEventInput;
    }
  | {
      readonly ok: false;
      readonly error: string;
    };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const getRequiredString = (
  record: Record<string, unknown>,
  key: string,
): string | null => {
  const value = record[key];
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > MAX_PERSISTED_STRING_LENGTH
  ) {
    return null;
  }
  return value;
};

const getOptionalStringOrNull = (
  record: Record<string, unknown>,
  key: string,
): string | null => {
  const value = record[key];
  if (value === undefined || value === null) {
    return null;
  }
  return typeof value === "string" &&
    value.length <= MAX_PERSISTED_STRING_LENGTH
    ? value
    : null;
};

const getOptionalTrimmedStringOrNull = (
  record: Record<string, unknown>,
  key: string,
): string | null => {
  const value = record[key];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed && trimmed.length <= MAX_PERSISTED_STRING_LENGTH
    ? trimmed
    : null;
};

const getRequiredBoolean = (
  record: Record<string, unknown>,
  key: string,
): boolean | null => {
  const value = record[key];
  return typeof value === "boolean" ? value : null;
};

const getPlatform = (record: Record<string, unknown>): Platform | null => {
  const value = record.platform;
  return value === "ios" || value === "android" ? value : null;
};

const getStatus = (
  record: Record<string, unknown>,
): "STABLE" | "RECOVERED" | null => {
  const value = record.status;
  return value === "STABLE" || value === "RECOVERED" ? value : null;
};

export const parseAppReadyBundleEvent = (
  payload: unknown,
  sdkVersionHeader: string | null,
): ParseAppReadyBundleEventResult => {
  if (!isRecord(payload)) {
    return { ok: false, error: "Invalid app-ready event payload" };
  }

  const hasOversizedPersistedString = PERSISTED_STRING_FIELDS.some((key) => {
    const value = payload[key];
    return (
      typeof value === "string" && value.length > MAX_PERSISTED_STRING_LENGTH
    );
  });
  if (
    hasOversizedPersistedString ||
    (sdkVersionHeader !== null &&
      sdkVersionHeader.trim().length > MAX_PERSISTED_STRING_LENGTH)
  ) {
    return { ok: false, error: "Invalid app-ready event payload" };
  }

  const activeBundleId = getRequiredString(payload, "activeBundleId");
  const channel = getRequiredString(payload, "channel");
  const defaultChannel = getRequiredString(payload, "defaultChannel");
  const installId = getRequiredString(payload, "installId");
  const isChannelSwitched = getRequiredBoolean(payload, "isChannelSwitched");
  const platform = getPlatform(payload);
  const status = getStatus(payload);
  const sdkVersion =
    getRequiredString(payload, "sdkVersion") ?? sdkVersionHeader?.trim();

  if (
    !activeBundleId ||
    !channel ||
    !defaultChannel ||
    !installId ||
    isChannelSwitched === null ||
    !platform ||
    !status ||
    !sdkVersion
  ) {
    return { ok: false, error: "Invalid app-ready event payload" };
  }

  return {
    ok: true,
    event: {
      kind: "APP_READY",
      installId,
      activeBundleId,
      previousActiveBundleId: getOptionalStringOrNull(
        payload,
        "previousActiveBundleId",
      ),
      crashedBundleId: getOptionalStringOrNull(payload, "crashedBundleId"),
      platform,
      channel,
      appVersion: getOptionalStringOrNull(payload, "appVersion"),
      fingerprintHash: getOptionalStringOrNull(payload, "fingerprintHash"),
      cohort: getOptionalStringOrNull(payload, "cohort"),
      userId: getOptionalTrimmedStringOrNull(payload, "userId"),
      payload: {
        status,
        sdkVersion,
        defaultChannel,
        isChannelSwitched,
      },
    },
  };
};
