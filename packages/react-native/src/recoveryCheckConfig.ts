import type { CheckForUpdateOptions } from "./checkForUpdate";
import { DEFAULT_REQUEST_TIMEOUT_MS } from "./fetchUpdateResponse";
import { getStorageItem, setStorageItem } from "./native";

/**
 * The native key-value entry native reads after a crash: once a launch of the
 * app ends in a crash, the next launch checks for an update natively, without
 * the app's JavaScript, whose own update flow may be what crashes. Native
 * knows no server of its own, so the app's JavaScript leaves it here. A
 * device whose JavaScript never configured Hot Updater, such as one whose
 * user hasn't accepted the privacy terms yet, has none, so native sends no
 * request.
 */
export const RECOVERY_CHECK_CONFIG_KEY = "hot-updater/recovery-check-config";

/** What native reads; native rejects any other `version`. */
interface RecoveryCheckConfig {
  readonly version: 1;
  readonly baseURL: string;
  readonly requestHeaders: Record<string, string>;
  readonly requestTimeoutMs: number;
  readonly updateStrategy: CheckForUpdateOptions["updateStrategy"];
}

const write = (config: RecoveryCheckConfig) => {
  // An update check never fails because native couldn't keep this.
  try {
    setStorageItem(RECOVERY_CHECK_CONFIG_KEY, JSON.stringify(config));
  } catch (error) {
    console.warn(
      "[HotUpdater] Failed to save the recovery check config",
      error,
    );
  }
};

const read = (): RecoveryCheckConfig | null => {
  try {
    const value = getStorageItem(RECOVERY_CHECK_CONFIG_KEY);
    if (value === null) return null;
    const parsed: unknown = JSON.parse(value);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      (parsed as { version?: unknown }).version === 1
    ) {
      return parsed as RecoveryCheckConfig;
    }
  } catch {}
  return null;
};

/**
 * Saves the request an update check makes, before it makes it: the server it
 * resolved, its headers and timeout, and its update strategy, which only a
 * check knows.
 */
export const saveRecoveryCheckConfig = (input: {
  readonly baseURL: string;
  readonly requestHeaders?: Record<string, string>;
  readonly requestTimeout?: number;
  readonly updateStrategy: CheckForUpdateOptions["updateStrategy"];
}) => {
  write({
    version: 1,
    baseURL: input.baseURL,
    requestHeaders: { ...input.requestHeaders },
    requestTimeoutMs: input.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT_MS,
    updateStrategy: input.updateStrategy,
  });
};

/**
 * Updates the saved request with what `HotUpdater.init` configures, so a
 * bundle that changed its server or API key and crashes before its first
 * check is still checked with its own. Its headers replace the saved ones,
 * never merge: a header the bundle no longer sends, such as another server's
 * credential, must not reach its server. A baseURL function resolves only in
 * a check, so the saved server stays until then. Nothing is saved before a check
 * has saved its update strategy. Like checks, a development build saves
 * nothing.
 */
export const refreshRecoveryCheckConfig = (input: {
  readonly baseURL: unknown;
  readonly requestHeaders?: Record<string, string>;
  readonly requestTimeout?: number;
}) => {
  // Read through typeof: init also runs where React Native defines no __DEV__.
  if (typeof __DEV__ !== "undefined" && __DEV__) return;
  const saved = read();
  if (saved === null) return;
  write({
    ...saved,
    ...(typeof input.baseURL === "string" && input.baseURL
      ? { baseURL: input.baseURL.replace(/\/+$/, "") }
      : {}),
    requestHeaders: { ...input.requestHeaders },
    ...(input.requestTimeout !== undefined
      ? { requestTimeoutMs: input.requestTimeout }
      : {}),
  });
};
