/**
 * The exchange between the app's `remoteConfig()` client plugin and the
 * `remoteConfig()` server plugin: `GET /remote-config`, relative to the
 * `baseURL` the app passes to `HotUpdater.init` or `HotUpdater.wrap`. The app
 * sends what conditions read as query parameters, and the server answers the
 * values the published template gives them. Both sides import this module,
 * which imports nothing, so the app's bundle never reaches server code.
 */

/** The path both sides use, relative to the app's `baseURL`. */
export const REMOTE_CONFIG_PATH = "remote-config";

/** What a device tells the server, so the server can evaluate conditions. */
export interface RemoteConfigDeviceContext {
  readonly platform: "ios" | "android";
  /** The native app version, or null when the build has none. */
  readonly appVersion: string | null;
  readonly channel: string;
  /** A numeric cohort from 1 to 1000, or a custom cohort's slug. */
  readonly cohort: string;
  /** The native build's fingerprint, or null without one. */
  readonly fingerprintHash: string | null;
}

/** The query parameter each context field travels in. */
export const REMOTE_CONFIG_QUERY = {
  platform: "platform",
  appVersion: "appVersion",
  channel: "channel",
  cohort: "cohort",
  fingerprintHash: "fingerprintHash",
} as const satisfies Record<keyof RemoteConfigDeviceContext, string>;

/**
 * `GET /remote-config?…`, with a field left out when it is null. It encodes
 * the query itself, since React Native's `URLSearchParams` throws on `set`.
 */
export const remoteConfigRequestPath = (
  context: RemoteConfigDeviceContext,
): string => {
  const query = (
    Object.keys(REMOTE_CONFIG_QUERY) as Array<keyof RemoteConfigDeviceContext>
  ).flatMap((field) => {
    const value = context[field];
    return value === null
      ? []
      : [
          `${encodeURIComponent(REMOTE_CONFIG_QUERY[field])}=${encodeURIComponent(value)}`,
        ];
  });
  return `${REMOTE_CONFIG_PATH}?${query.join("&")}`;
};

/** The body of a `200` from `GET /remote-config`. */
export interface RemoteConfigFetchResponse {
  /** The published template version the values come from; 0 before the first publish. */
  readonly version: number;
  /**
   * Each parameter's value for this device, as text, as Firebase Remote
   * Config sends values. A parameter whose value is the app's own default is
   * left out.
   */
  readonly values: Readonly<Record<string, string>>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A `200` body, checked; null when it is not one. */
export const parseRemoteConfigFetchResponse = (
  value: unknown,
): RemoteConfigFetchResponse | null => {
  if (!isRecord(value)) return null;
  const { version, values } = value;
  if (
    typeof version !== "number" ||
    !Number.isSafeInteger(version) ||
    version < 0 ||
    !isRecord(values)
  ) {
    return null;
  }
  const entries = Object.entries(values);
  if (entries.some(([, text]) => typeof text !== "string")) return null;
  return { version, values: Object.fromEntries(entries) as never };
};
