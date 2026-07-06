import type { Platform } from "@hot-updater/core";
import type { DatabaseBundleEventInput } from "@hot-updater/plugin-core";

export const UNSUPPORTED_BUNDLE_EVENTS_MESSAGE =
  "Bundle events are not supported by this database provider.";

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
  if (typeof value !== "string" || !value.trim()) {
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
  return typeof value === "string" ? value : null;
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
      payload: {
        status,
        sdkVersion,
        defaultChannel,
        isChannelSwitched,
      },
    },
  };
};
