import type { CheckForUpdateOptions } from "./checkForUpdate";
import { DEFAULT_REQUEST_TIMEOUT_MS } from "./fetchUpdateResponse";
import { setStorageItem } from "./native";

/**
 * The native key-value entry native reads after a crash: once a launch of the
 * app ends in a crash that doesn't roll back, the next launch checks for an
 * update natively, without the app's JavaScript, whose own update flow may be
 * what crashes. Native knows no server of its own, so the app's update checks
 * leave it here. A device that never checked, such as one whose user hasn't
 * accepted the privacy terms yet, has none, so native sends no request.
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

/**
 * Saves the request an update check makes, before it makes it: the server it
 * resolved, its headers and timeout, and its update strategy, which only a
 * check knows. Only checks save it, so native always repeats a request the
 * app really made, whichever instance made it last, and a device that never
 * checked sends nothing. The channel is left out on purpose: native checks
 * the device's own channel, the one the crashing bundle came from and its fix
 * is published to. A check of another channel is a one-off until its update
 * is applied, and a crash must not switch the device's channel.
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
