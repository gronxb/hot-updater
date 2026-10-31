import { Platform } from "react-native";

import {
  appendNativeUpdateLog,
  clearNativeUpdateLogs,
  getAppVersion,
  getBundleId,
  getChannel,
  getFingerprintHash,
  getMinBundleId,
  readNativeUpdateLogs,
  readNativeUpdateStatus,
} from "./native";

/** Why `checkForUpdate` never reaches the server in this build. */
export type UpdateDisabledReason =
  /** `__DEV__` is true: a bundle from the development server or a dev build. */
  | "DEVELOPMENT_BUILD"
  /** Hot Updater runs on iOS and Android only. */
  | "UNSUPPORTED_PLATFORM"
  /** Native could not read the app's version. */
  | "MISSING_APP_VERSION";

/** What this app runs now and what its next restart runs, read locally. */
export interface UpdateStatusSnapshot {
  /** Whether `checkForUpdate` can reach the server in this build. */
  readonly isEnabled: boolean;
  readonly disabledReason: UpdateDisabledReason | null;
  /**
   * Whether the next restart runs another bundle than the running one: a
   * downloaded update, or the built-in bundle after a rollback or a channel
   * reset. `null` when native was built from an SDK that cannot tell.
   */
  readonly isUpdatePending: boolean | null;
  /**
   * The bundle the next restart runs, when it is not the running one; the
   * built-in bundle's ID when the restart returns to it.
   */
  readonly pendingBundleId: string | null;
  /** The bundle running now, which a staged update does not change. */
  readonly bundleId: string;
  readonly channel: string;
  readonly appVersion: string | null;
  readonly fingerprintHash: string | null;
  readonly minBundleId: string;
}

export type UpdateLogType =
  | "CHECK"
  | "DOWNLOAD"
  | "APPLY"
  | "ROLLBACK"
  | "CRASH_RECOVERY";

export type UpdateLogOutcome =
  // CHECK
  | "UP_TO_DATE"
  | "UPDATE_AVAILABLE"
  | "ROLLBACK_AVAILABLE"
  // CHECK and DOWNLOAD
  | "FAILED"
  // DOWNLOAD
  | "STAGED"
  // APPLY
  | "APPLIED"
  // ROLLBACK
  | "BUILT_IN_SELECTED"
  | "CHANNEL_RESET"
  // CRASH_RECOVERY
  | "ROLLED_BACK_AFTER_CRASH"
  | "ROLLED_BACK_UNFINISHED_LAUNCH"
  | "ROLLED_BACK_MISSING_BUNDLE"
  | "KEPT_AFTER_CRASH";

export interface UpdateLogError {
  readonly code: string | null;
  /** The error's message, with every URL cut down to its host. */
  readonly message: string | null;
  readonly stage: string | null;
  readonly reason: string | null;
}

/** One update event, recorded on this device. */
export interface UpdateLogEntry {
  /** When it happened, in milliseconds since the epoch. */
  readonly timestamp: number;
  readonly type: UpdateLogType;
  readonly outcome: UpdateLogOutcome;
  /** The bundle the event is about, such as the one downloaded or rolled back. */
  readonly bundleId: string | null;
  /** The bundle the app moved away from, when the event moved it. */
  readonly fromBundleId: string | null;
  readonly releaseId: string | null;
  readonly channel: string | null;
  readonly error: UpdateLogError | null;
}

export interface GetUpdateLogsOptions {
  /** Only entries at most this many milliseconds old. */
  readonly maxAge?: number;
  /** Only this many of the newest entries. */
  readonly limit?: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const readString = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const parseJson = (value: unknown): unknown => {
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

const getDisabledReason = (): UpdateDisabledReason | null => {
  if (__DEV__) return "DEVELOPMENT_BUILD";
  if (Platform.OS !== "ios" && Platform.OS !== "android") {
    return "UNSUPPORTED_PLATFORM";
  }
  return getAppVersion() ? null : "MISSING_APP_VERSION";
};

/**
 * Reads the running and the next bundle from native, or null when native was
 * built from an earlier SDK or cannot answer.
 */
const readNativeStatus = async (): Promise<{
  readonly bundleId: string;
  readonly pendingBundleId: string | null;
} | null> => {
  let value: unknown;
  try {
    value = parseJson(await readNativeUpdateStatus());
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  const bundleId = readString(value.bundleId);
  if (bundleId === null) return null;
  return { bundleId, pendingBundleId: readString(value.pendingBundleId) };
};

/**
 * Reads whether over-the-air updates are on in this build, whether a restart
 * would change the running bundle, and the values support asks for, without a
 * network request.
 */
export const getUpdateStatus = async (): Promise<UpdateStatusSnapshot> => {
  const nativeStatus = await readNativeStatus();
  const disabledReason = getDisabledReason();
  return {
    isEnabled: disabledReason === null,
    disabledReason,
    isUpdatePending: nativeStatus && nativeStatus.pendingBundleId !== null,
    pendingBundleId: nativeStatus?.pendingBundleId ?? null,
    bundleId: nativeStatus?.bundleId ?? getBundleId(),
    channel: getChannel(),
    appVersion: getAppVersion(),
    fingerprintHash: getFingerprintHash(),
    minBundleId: getMinBundleId(),
  };
};

const readLogError = (value: unknown): UpdateLogError | null => {
  if (!isRecord(value)) return null;
  return {
    code: readString(value.code),
    message: readString(value.message),
    stage: readString(value.stage),
    reason: readString(value.reason),
  };
};

const readLogEntry = (value: unknown): UpdateLogEntry | null => {
  if (!isRecord(value)) return null;
  const { timestamp, type, outcome } = value;
  if (
    typeof timestamp !== "number" ||
    typeof type !== "string" ||
    typeof outcome !== "string"
  ) {
    return null;
  }
  return {
    timestamp,
    type: type as UpdateLogType,
    outcome: outcome as UpdateLogOutcome,
    bundleId: readString(value.bundleId),
    fromBundleId: readString(value.fromBundleId),
    releaseId: readString(value.releaseId),
    channel: readString(value.channel),
    error: readLogError(value.error),
  };
};

/**
 * Reads this device's update log, newest first, without a network request.
 * Resolves with null when native was built from an SDK without the log, which
 * is not the same as an empty log.
 */
export const getUpdateLogs = async (
  options: GetUpdateLogsOptions = {},
): Promise<UpdateLogEntry[] | null> => {
  const stored = await readNativeUpdateLogs();
  if (stored === undefined || stored === null) return null;
  const value = parseJson(stored);
  if (!Array.isArray(value)) return [];

  const { maxAge, limit } = options;
  const oldest = maxAge === undefined ? null : Date.now() - maxAge;
  const entries = value
    .map(readLogEntry)
    .filter(
      (entry): entry is UpdateLogEntry =>
        entry !== null && (oldest === null || entry.timestamp >= oldest),
    )
    .reverse();
  return limit === undefined ? entries : entries.slice(0, Math.max(0, limit));
};

/**
 * Deletes this device's update log. Resolves with false when native was built
 * from an SDK without the log.
 */
export const clearUpdateLogs = async (): Promise<boolean> =>
  (await clearNativeUpdateLogs()) === true;

/**
 * What JavaScript adds to the log, the parts of an update only it sees: a
 * check, and a download that failed before native staged anything. Native
 * stamps its time.
 */
export type JavaScriptUpdateLog = {
  readonly type: Extract<UpdateLogType, "CHECK" | "DOWNLOAD">;
  readonly outcome: Extract<
    UpdateLogOutcome,
    "UP_TO_DATE" | "UPDATE_AVAILABLE" | "ROLLBACK_AVAILABLE" | "FAILED"
  >;
  readonly bundleId?: string | null;
  readonly fromBundleId?: string | null;
  readonly releaseId?: string | null;
  readonly channel?: string | null;
  readonly error?: unknown;
};

/**
 * Records an event. The log only describes the update: it never gets in the
 * way of one, so a failure to record is ignored.
 */
export const recordUpdateLog = (log: JavaScriptUpdateLog): void => {
  try {
    const { error, ...entry } = log;
    appendNativeUpdateLog(
      JSON.stringify({
        ...entry,
        ...(error === undefined ? {} : { error: describeError(error) }),
      }),
    );
  } catch {
    // Native reports nothing back, and the update goes on either way.
  }
};

const describeError = (error: unknown): Record<string, unknown> => {
  if (!isRecord(error) && !(error instanceof Error)) {
    return { message: String(error) };
  }
  const { code, message, userInfo } = error as {
    code?: unknown;
    message?: unknown;
    userInfo?: { stage?: unknown; reason?: unknown } | null;
  };
  return {
    code,
    message,
    stage: userInfo?.stage,
    reason: userInfo?.reason,
  };
};
