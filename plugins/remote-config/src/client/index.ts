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
 * Where a value comes from: `remote` from the activated values, `default`
 * from the in-app defaults. A key neither has reads as `null`.
 */
export type RemoteConfigValueSource = "default" | "remote";

/** How the last fetch ended: `failure` for any error, a `429` included. */
export type RemoteConfigFetchStatus = "no-fetch-yet" | "success" | "failure";

/** A parameter's value, read as the type the app expects. */
export interface RemoteConfigValue {
  /** The text, `""` included. */
  asString(): string;
  /** The text as a number, `0` included; 0 for text that is not a number. */
  asNumber(): number;
  /** Whether the text is `1`, `true`, `t`, `yes`, `y`, or `on`, in any case. */
  asBoolean(): boolean;
  getSource(): RemoteConfigValueSource;
}

/** No defaults: every key may read as `null`. */
type NoDefaults = Record<never, never>;

export interface RemoteConfigOptions<
  TDefaults extends RemoteConfigDefaults = NoDefaults,
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

export interface RemoteConfigFetchOptions {
  /**
   * Asks the server even within `minimumFetchIntervalMs`, for a moment that
   * needs fresh values, such as pull to refresh. Each one is a request (a
   * `304` when nothing changed).
   */
  readonly force?: boolean;
}

/** A defaults key, with any other key still accepted. */
export type RemoteConfigKey<TDefaults> =
  | (keyof TDefaults & string)
  | (string & {});

/**
 * What a read of `TKey` returns: `T` for a key `defaults` declares, which
 * always has a value, and `T | null` for any other key. Defaults typed as
 * a map of any string, such as `RemoteConfigDefaults`, declare no key.
 */
export type RemoteConfigRead<
  TDefaults,
  TKey extends string,
  T,
> = string extends keyof TDefaults
  ? T | null
  : TKey extends keyof TDefaults
    ? T
    : T | null;

/**
 * Remote Config on the instance `HotUpdater.init` returns, as
 * `hotUpdater.remoteConfig`.
 */
export interface RemoteConfigClient<
  TDefaults extends RemoteConfigDefaults = NoDefaults,
> {
  /**
   * A parameter's value: the active remote value, else the in-app default,
   * else `null`. Reads are synchronous; `init` loads the values the app
   * activated last from the device. `false`, `0`, and `""` are values, not
   * missing ones.
   */
  getValue<TKey extends RemoteConfigKey<TDefaults>>(
    key: TKey,
  ): RemoteConfigRead<TDefaults, TKey, RemoteConfigValue>;
  getString<TKey extends RemoteConfigKey<TDefaults>>(
    key: TKey,
  ): RemoteConfigRead<TDefaults, TKey, string>;
  getNumber<TKey extends RemoteConfigKey<TDefaults>>(
    key: TKey,
  ): RemoteConfigRead<TDefaults, TKey, number>;
  getBoolean<TKey extends RemoteConfigKey<TDefaults>>(
    key: TKey,
  ): RemoteConfigRead<TDefaults, TKey, boolean>;
  /**
   * Every key the defaults or the active values have. The object stays the
   * same until the values change, so it suits `useSyncExternalStore`.
   */
  getAll(): Readonly<Record<string, RemoteConfigValue>>;
  /**
   * Fetches this device's values from `GET /remote-config` on the
   * `baseURL` the app configured, with its request headers, and keeps them
   * for `activate`; active values do not change. Within
   * `minimumFetchIntervalMs` of the last successful fetch it keeps those
   * values without a request, unless `force` is set. Rejects when the server
   * cannot be reached or runs without the `remoteConfig()` plugin.
   */
  fetch(options?: RemoteConfigFetchOptions): Promise<void>;
  /** Makes the fetched values active; true when they replaced other values. */
  activate(): Promise<boolean>;
  readonly lastFetchStatus: RemoteConfigFetchStatus;
  /** When the last successful fetch ended, in ms since the epoch; `null` before one. */
  readonly fetchedAtMs: number | null;
  /** The template version the active values come from; 0 before any. */
  readonly activeVersion: number;
  /** Calls `listener` whenever the active values change; returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
}

/** The `remoteConfig()` plugin: it adds `hotUpdater.remoteConfig`. */
export type RemoteConfigPlugin<
  TDefaults extends RemoteConfigDefaults = NoDefaults,
> = HotUpdaterClientPlugin<"remoteConfig", RemoteConfigClient<TDefaults>>;

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
    asString: () => text,
    asNumber: () => {
      const number = Number(text);
      return Number.isNaN(number) ? 0 : number;
    },
    asBoolean: () => BOOLEAN_TRUTHY_VALUES.has(text.toLowerCase()),
    getSource: () => source,
  });

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
  value === "success" || value === "failure";

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
 * step between them. Add it to `HotUpdater.init`'s `plugins`, and read it
 * from the instance `init` returns, as `hotUpdater.remoteConfig`. It fetches
 * from the `baseURL`, request headers, and timeout configured there.
 *
 * @example
 * ```ts
 * import { HotUpdater, remoteConfig } from "@hot-updater/react-native";
 *
 * export const hotUpdater = HotUpdater.init({
 *   baseURL,
 *   plugins: [
 *     remoteConfig({ defaults: { welcome_message: "Welcome", max_items: 20 } }),
 *   ],
 * });
 *
 * hotUpdater.remoteConfig
 *   .fetch()
 *   .then(() => hotUpdater.remoteConfig.activate())
 *   .catch(() => {});
 * hotUpdater.remoteConfig.getString("welcome_message");
 * ```
 */
export const remoteConfig = <
  const TDefaults extends RemoteConfigDefaults = NoDefaults,
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
  return defineClientPlugin({
    id: "remoteConfig",
    setup: (context) => ({
      api: createRemoteConfigClient<TDefaults>(context, {
        defaults,
        minimumFetchIntervalMs,
      }),
    }),
  });
};

/** The client a plugin's `setup` creates, over the values stored on the device. */
const createRemoteConfigClient = <TDefaults extends RemoteConfigDefaults>(
  context: HotUpdaterClientContext,
  {
    defaults,
    minimumFetchIntervalMs,
  }: {
    readonly defaults: Readonly<Record<string, string>>;
    readonly minimumFetchIntervalMs: number;
  },
): RemoteConfigClient<TDefaults> => {
  // Read synchronously, so the first render after init has the values the
  // app activated at an earlier launch.
  let active = parseStored<StoredValues>(
    context.storage.get(ACTIVE_KEY),
    () => true,
  );
  let fetched = parseStored<StoredFetch>(
    context.storage.get(FETCHED_KEY),
    (record) =>
      typeof record.context === "string" &&
      typeof record.fetchedAtMs === "number",
  );
  const storedStatus = context.storage.get(LAST_FETCH_STATUS_KEY);
  let lastFetchStatus: RemoteConfigFetchStatus = isFetchStatus(storedStatus)
    ? storedStatus
    : fetched === null
      ? "no-fetch-yet"
      : "success";
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

  // The active remote value, else the in-app default, else null.
  const getValue = (key: string): RemoteConfigValue | null => {
    const remote = ownEntry(active?.values, key);
    if (remote !== undefined) return createValue(remote, "remote");
    const fallback = ownEntry(defaults, key);
    return fallback === undefined ? null : createValue(fallback, "default");
  };

  const fetchFromServer = async (
    device: RemoteConfigDeviceContext,
  ): Promise<void> => {
    const contextKey = JSON.stringify(device);
    let response: Response;
    try {
      response = await context.fetch(remoteConfigRequestPath(device), {
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
    const fetchedAtMs = context.now();
    if (response.status === 304 && fetched !== null) {
      fetched = { ...fetched, context: contextKey, fetchedAtMs };
      store(FETCHED_KEY, JSON.stringify(fetched));
      setStatus("success");
      return;
    }
    if (!response.ok) {
      setStatus("failure");
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

  // Checked before joining a running fetch, so every shared one is a request.
  const fetchValues = (options?: RemoteConfigFetchOptions): Promise<void> => {
    const device = deviceContext(context);
    if (
      options?.force !== true &&
      inFlight === null &&
      fetched !== null &&
      fetched.context === JSON.stringify(device) &&
      context.now() - fetched.fetchedAtMs < minimumFetchIntervalMs
    ) {
      return Promise.resolve();
    }
    inFlight ??= fetchFromServer(device).finally(() => {
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

  // One implementation serves every key; the read types, non-null for keys
  // `defaults` declares, hold because every such key has a default value.
  const client = Object.freeze({
    getValue,
    getString: (key: string) => getValue(key)?.asString() ?? null,
    getNumber: (key: string) => getValue(key)?.asNumber() ?? null,
    getBoolean: (key: string) => getValue(key)?.asBoolean() ?? null,
    getAll: () => {
      snapshot ??= Object.freeze(
        Object.fromEntries(
          [
            ...new Set([
              ...Object.keys(defaults),
              ...Object.keys(active?.values ?? {}),
            ]),
          ].map((key) => [key, getValue(key)!]),
        ),
      );
      return snapshot;
    },
    fetch: (options?: RemoteConfigFetchOptions) => fetchValues(options),
    activate,
    get lastFetchStatus() {
      return lastFetchStatus;
    },
    get fetchedAtMs() {
      return fetched?.fetchedAtMs ?? null;
    },
    get activeVersion() {
      return active?.version ?? 0;
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  });
  return client as unknown as RemoteConfigClient<TDefaults>;
};
