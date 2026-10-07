import {
  defineClientPlugin,
  type HotUpdaterClientContext,
  type HotUpdaterClientPlugin,
} from "@hot-updater/protocol";

import { ownEntry } from "../shared/ownEntry";
import {
  parseRemoteConfigFetchResponse,
  type RemoteConfigDeviceContext,
  remoteConfigRequestPath,
} from "../shared/wire";

/** An in-app default value: text, a number, or a boolean. */
export type RemoteConfigDefaultValue = string | number | boolean;

export type RemoteConfigDefaults = Readonly<
  Record<string, RemoteConfigDefaultValue>
>;

/**
 * Where a value comes from: `remote` from the activated template, `default`
 * from the in-app defaults, `static` when neither has the key.
 */
export type RemoteConfigValueSource = "static" | "default" | "remote";

/**
 * How the last fetch ended: `throttle` when the server asked the app to
 * slow down (429), `failure` for any other error.
 */
export type RemoteConfigFetchStatus =
  | "no-fetch-yet"
  | "success"
  | "failure"
  | "throttle";

/** A parameter's value, read as the type the app expects. */
export interface RemoteConfigValue {
  /** The text; `""` for a static value. */
  asString(): string;
  /** The text as a number; 0 for a static value or text that is not a number. */
  asNumber(): number;
  /** Whether the text is `1`, `true`, `t`, `yes`, `y`, or `on`, in any case; false for a static value. */
  asBoolean(): boolean;
  getSource(): RemoteConfigValueSource;
}

export interface RemoteConfigOptions<
  TDefaults extends RemoteConfigDefaults = RemoteConfigDefaults,
> {
  /** Values the app uses until it activates fetched ones, and for keys the template leaves to it. */
  readonly defaults?: TDefaults;
  /**
   * The shortest time between fetches that reach the server; a fetch
   * sooner keeps the values fetched last. Defaults to 12 hours. A fetch
   * always reaches the server after the app's channel, version, cohort, or
   * fingerprint changes.
   */
  readonly minimumFetchIntervalMs?: number;
}

/** A defaults key, with any other key still accepted. */
export type RemoteConfigKey<TDefaults> =
  | (keyof TDefaults & string)
  | (string & {});

export interface RemoteConfigPlugin<
  TDefaults extends RemoteConfigDefaults = RemoteConfigDefaults,
> extends HotUpdaterClientPlugin {
  readonly id: "remoteConfig";
  /**
   * A parameter's active value. Reads are synchronous: after
   * `HotUpdater.init` or `HotUpdater.wrap` they return the values the app
   * activated last, stored on the device, and before that the defaults.
   */
  getValue(key: RemoteConfigKey<TDefaults>): RemoteConfigValue;
  getString(key: RemoteConfigKey<TDefaults>): string;
  getNumber(key: RemoteConfigKey<TDefaults>): number;
  getBoolean(key: RemoteConfigKey<TDefaults>): boolean;
  /**
   * Every key the defaults or the active values have. The object stays the
   * same until the values change, so it suits `useSyncExternalStore`.
   */
  getAll(): Readonly<Record<string, RemoteConfigValue>>;
  /**
   * Fetches this device's values from `GET /remote-config` on the
   * `baseURL` the app configured, with its request headers, and keeps them
   * for `activate`; active values do not change. Rejects when the server
   * cannot be reached or runs without the `remoteConfig()` plugin.
   */
  fetch(): Promise<void>;
  /** Makes the fetched values active; true when they replaced other values. */
  activate(): Promise<boolean>;
  /** `fetch`, then `activate`. */
  fetchAndActivate(): Promise<boolean>;
  readonly lastFetchStatus: RemoteConfigFetchStatus;
  /** When the last successful fetch ended, in ms since the epoch; -1 before one. */
  readonly fetchTimeMillis: number;
  /** The template version the active values come from; 0 before any. */
  readonly activeVersion: number;
  /** Calls `listener` whenever the active values change; returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
}

const DEFAULT_MINIMUM_FETCH_INTERVAL_MS = 12 * 60 * 60 * 1000;
const BOOLEAN_TRUTHY_VALUES = new Set(["1", "true", "t", "yes", "y", "on"]);
const FETCHED_KEY = "fetched";
const ACTIVE_KEY = "active";
const LAST_FETCH_STATUS_KEY = "lastFetchStatus";

/** Values the app fetched or activated, as the plugin stores them. */
interface StoredValues {
  readonly version: number;
  readonly values: Readonly<Record<string, string>>;
  readonly etag: string | null;
}

interface StoredFetch extends StoredValues {
  /** The device context the server evaluated, so a change refetches. */
  readonly context: string;
  readonly fetchedAtMs: number;
}

const createValue = (
  text: string,
  source: RemoteConfigValueSource,
): RemoteConfigValue =>
  Object.freeze({
    asString: () => (source === "static" ? "" : text),
    asNumber: () => {
      if (source === "static") return 0;
      const number = Number(text);
      return Number.isNaN(number) ? 0 : number;
    },
    asBoolean: () =>
      source !== "static" && BOOLEAN_TRUTHY_VALUES.has(text.toLowerCase()),
    getSource: () => source,
  });

const STATIC_VALUE = createValue("", "static");

const parseStored = <T extends StoredValues>(
  text: string | null,
  extra: (value: Record<string, unknown>) => boolean,
): T | null => {
  if (text === null) return null;
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null) return null;
    const record = value as Record<string, unknown>;
    const response = parseRemoteConfigFetchResponse(record);
    if (
      response === null ||
      (record.etag !== null && typeof record.etag !== "string") ||
      !extra(record)
    ) {
      return null;
    }
    return record as unknown as T;
  } catch {
    return null;
  }
};

const isFetchStatus = (value: unknown): value is RemoteConfigFetchStatus =>
  value === "success" || value === "failure" || value === "throttle";

const deviceContext = (
  context: HotUpdaterClientContext,
): RemoteConfigDeviceContext => ({
  platform: context.platform,
  appVersion: context.appVersion,
  channel: context.getChannel(),
  cohort: context.getCohort(),
  fingerprintHash: context.getFingerprintHash(),
});

/**
 * Remote Config for the app: in-app defaults, values a server running the
 * `remoteConfig()` plugin picks for this device, and a fetch and activate
 * step between them. Add it to
 * `HotUpdater.init` or `HotUpdater.wrap`'s `plugins`; it fetches from the
 * `baseURL`, request headers, and timeout configured there.
 *
 * @example
 * ```ts
 * import { HotUpdater, remoteConfig } from "@hot-updater/react-native";
 *
 * export const config = remoteConfig({
 *   defaults: { welcome_message: "Welcome", max_items: 20 },
 * });
 *
 * HotUpdater.init({ baseURL, plugins: [config] });
 * config.fetchAndActivate().catch(() => {});
 *
 * config.getString("welcome_message");
 * ```
 */
export const remoteConfig = <
  const TDefaults extends RemoteConfigDefaults = RemoteConfigDefaults,
>(
  options: RemoteConfigOptions<TDefaults> = {},
): RemoteConfigPlugin<TDefaults> => {
  const minimumFetchIntervalMs =
    options.minimumFetchIntervalMs ?? DEFAULT_MINIMUM_FETCH_INTERVAL_MS;
  if (
    typeof minimumFetchIntervalMs !== "number" ||
    !Number.isFinite(minimumFetchIntervalMs) ||
    minimumFetchIntervalMs < 0
  ) {
    throw new TypeError(
      "[HotUpdater] remoteConfig({ minimumFetchIntervalMs }) must be a non-negative number.",
    );
  }
  const defaults: Readonly<Record<string, string>> = Object.fromEntries(
    Object.entries(options.defaults ?? {}).map(([key, value]) => [
      key,
      String(value),
    ]),
  );

  let context: HotUpdaterClientContext | null = null;
  let active: StoredValues | null = null;
  let fetched: StoredFetch | null = null;
  let lastFetchStatus: RemoteConfigFetchStatus = "no-fetch-yet";
  let inFlight: Promise<void> | null = null;
  let snapshot: Readonly<Record<string, RemoteConfigValue>> | null = null;
  const listeners = new Set<() => void>();

  const notify = () => {
    snapshot = null;
    for (const listener of listeners) {
      try {
        listener();
      } catch (error) {
        console.warn("[HotUpdater] A remoteConfig listener threw.", error);
      }
    }
  };

  const store = (key: string, value: string | null) => {
    if (context === null) return;
    try {
      context.storage.set(key, value);
    } catch (error) {
      console.warn(
        `[HotUpdater] remoteConfig could not store its ${key} values.`,
        error,
      );
    }
  };

  const setStatus = (status: RemoteConfigFetchStatus) => {
    lastFetchStatus = status;
    store(LAST_FETCH_STATUS_KEY, status);
  };

  const getValue = (key: string): RemoteConfigValue => {
    const remote = ownEntry(active?.values, key);
    if (remote !== undefined) return createValue(remote, "remote");
    const fallback = ownEntry(defaults, key);
    return fallback === undefined
      ? STATIC_VALUE
      : createValue(fallback, "default");
  };

  const fetchFromServer = async (
    pluginContext: HotUpdaterClientContext,
  ): Promise<void> => {
    const device = deviceContext(pluginContext);
    const contextKey = JSON.stringify(device);
    if (
      fetched !== null &&
      fetched.context === contextKey &&
      pluginContext.now() - fetched.fetchedAtMs < minimumFetchIntervalMs
    ) {
      return;
    }
    let response: Response;
    try {
      response = await pluginContext.fetch(remoteConfigRequestPath(device), {
        headers:
          fetched === null || fetched.etag === null
            ? {}
            : { "if-none-match": fetched.etag },
      });
    } catch (error) {
      setStatus("failure");
      throw new Error("[HotUpdater] Remote Config could not be fetched.", {
        cause: error,
      });
    }
    const fetchedAtMs = pluginContext.now();
    if (response.status === 304 && fetched !== null) {
      fetched = { ...fetched, context: contextKey, fetchedAtMs };
      store(FETCHED_KEY, JSON.stringify(fetched));
      setStatus("success");
      return;
    }
    if (!response.ok) {
      setStatus(response.status === 429 ? "throttle" : "failure");
      throw new Error(
        response.status === 404
          ? "[HotUpdater] The server answered 404 to GET /remote-config: it runs without the remoteConfig() plugin."
          : `[HotUpdater] Remote Config fetch failed with HTTP ${response.status}.`,
      );
    }
    const body = parseRemoteConfigFetchResponse(
      await response.json().catch(() => null),
    );
    if (body === null) {
      setStatus("failure");
      throw new Error(
        "[HotUpdater] The server's GET /remote-config answer is not Remote Config values.",
      );
    }
    fetched = {
      version: body.version,
      values: body.values,
      etag: response.headers.get("etag"),
      context: contextKey,
      fetchedAtMs,
    };
    store(FETCHED_KEY, JSON.stringify(fetched));
    setStatus("success");
  };

  const fetchValues = (): Promise<void> => {
    if (context === null) {
      return Promise.reject(
        new Error(
          "[HotUpdater] remoteConfig fetches only after HotUpdater.init or HotUpdater.wrap sets it up with plugins: [config].",
        ),
      );
    }
    inFlight ??= fetchFromServer(context).finally(() => {
      inFlight = null;
    });
    return inFlight;
  };

  const activate = async (): Promise<boolean> => {
    if (fetched === null) return false;
    const next: StoredValues = {
      version: fetched.version,
      values: fetched.values,
      etag: fetched.etag,
    };
    if (
      active !== null &&
      active.version === next.version &&
      JSON.stringify(active.values) === JSON.stringify(next.values)
    ) {
      return false;
    }
    active = next;
    store(ACTIVE_KEY, JSON.stringify(active));
    notify();
    return true;
  };

  const plugin: RemoteConfigPlugin<TDefaults> = {
    id: "remoteConfig",
    setup(pluginContext) {
      context = pluginContext;
      active = parseStored<StoredValues>(
        pluginContext.storage.get(ACTIVE_KEY),
        () => true,
      );
      fetched = parseStored<StoredFetch>(
        pluginContext.storage.get(FETCHED_KEY),
        (record) =>
          typeof record.context === "string" &&
          typeof record.fetchedAtMs === "number",
      );
      const status = pluginContext.storage.get(LAST_FETCH_STATUS_KEY);
      lastFetchStatus = isFetchStatus(status)
        ? status
        : fetched === null
          ? "no-fetch-yet"
          : "success";
      if (active !== null) notify();
    },
    getValue,
    getString: (key) => getValue(key).asString(),
    getNumber: (key) => getValue(key).asNumber(),
    getBoolean: (key) => getValue(key).asBoolean(),
    getAll: () => {
      snapshot ??= Object.freeze(
        Object.fromEntries(
          [
            ...new Set([
              ...Object.keys(defaults),
              ...Object.keys(active?.values ?? {}),
            ]),
          ].map((key) => [key, getValue(key)]),
        ),
      );
      return snapshot;
    },
    fetch: fetchValues,
    activate,
    fetchAndActivate: async () => {
      await fetchValues();
      return activate();
    },
    get lastFetchStatus() {
      return lastFetchStatus;
    },
    get fetchTimeMillis() {
      return fetched?.fetchedAtMs ?? -1;
    },
    get activeVersion() {
      return active?.version ?? 0;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return defineClientPlugin(plugin);
};
