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
 * The headers as the request sent them: `Headers` lowercases names and
 * joins two spellings of one name, as the catalog request did, so native
 * repeats the same values instead of picking one of the spellings.
 */
const sentHeaders = (headers: Record<string, string> | undefined) =>
  Object.fromEntries(new Headers(headers).entries());

/**
 * Saves the request of an update check the server answered: the server it
 * resolved, its headers and timeout, and its update strategy, which only a
 * check knows. Only answered checks save it, so native always repeats a
 * request that reached the server, whichever instance made it last, and a
 * device that never checked sends nothing. Native checks of main save theirs
 * the same way. The channel is left out on purpose: native checks
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
    requestHeaders: sentHeaders(input.requestHeaders),
    requestTimeoutMs: input.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT_MS,
    updateStrategy: input.updateStrategy,
  });
};
