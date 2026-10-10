import { resolveBaseURL, type HotUpdaterBaseURL } from "./baseURL";
import type {
  HotUpdaterClientContext,
  HotUpdaterClientHooks,
  HotUpdaterClientPlugin,
  HotUpdaterClientSetup,
  HotUpdaterClientStorage,
} from "./clientPlugin";

export type PluginHookName = keyof HotUpdaterClientHooks;
export type PluginHookPayload<K extends PluginHookName> = Parameters<
  NonNullable<HotUpdaterClientHooks[K]>
>[0];

/** The init settings plugins see through their context. */
export interface PluginHostConfig {
  readonly baseURL: HotUpdaterBaseURL;
  readonly requestHeaders?: Record<string, string>;
  readonly requestTimeout?: number;
  readonly onError?: (error: unknown) => void;
}

/**
 * What plugins read from the app and the device. A device SDK backs it with
 * its native module; the SDK test utilities back it with
 * fakes.
 */
export interface PluginHostEnvironment {
  fetch(url: string, init: RequestInit): Promise<Response>;
  readonly platform: "ios" | "android";
  readonly isDebugBuild: boolean;
  readonly sdkVersion: string;
  getInstallId(): string;
  getAppVersion(): string | null;
  getMinBundleId(): string;
  getBundleId(): string;
  getChannel(): string;
  getCohort(): string;
  getFingerprintHash(): string | null;
  getStorageItem(key: string): string | null;
  setStorageItem(key: string, value: string | null): void;
  now(): number;
}

export interface PluginHost {
  /**
   * Sets up the plugins of an init call and returns their APIs by plugin
   * id. A plugin passed to an earlier call keeps its hooks and its API, and
   * a plugin left out stops receiving events.
   */
  configurePlugins(
    plugins: readonly HotUpdaterClientPlugin[] | undefined,
    config: PluginHostConfig,
  ): Readonly<Record<string, unknown>>;
  /** Whether any plugin listens to this hook, so callers build events only when one does. */
  hasPluginHook(name: PluginHookName): boolean;
  /**
   * Builds a hook's event when a plugin listens. A failure to build it is
   * reported, not thrown, since reporting never changes an update.
   */
  buildPluginEvent<K extends PluginHookName>(
    name: K,
    createPayload: () => PluginHookPayload<K> | null,
  ): PluginHookPayload<K> | null;
  /**
   * Calls a hook on every plugin that listens, without waiting for any. It
   * returns when each asynchronous hook settles, for observers such as
   * `@hot-updater/test-utils`; the SDK ignores it.
   */
  dispatchPluginHook<K extends PluginHookName>(
    name: K,
    payload: PluginHookPayload<K>,
  ): readonly Promise<void>[];
  /** Builds a hook's event when a plugin listens and calls the hook right away. */
  emitPluginHook<K extends PluginHookName>(
    name: K,
    createPayload: () => PluginHookPayload<K> | null,
  ): void;
}

/** Storage values stay small, since native reads them on the JS thread. */
const MAX_STORAGE_VALUE_LENGTH = 64 * 1024;

/** Where a plugin's key lives in native storage. */
export const pluginStorageKey = (pluginId: string, key: string): string =>
  // Encoded, so no id and key pair can name another plugin's key.
  `plugins/${encodeURIComponent(pluginId)}/${key}`;

export const createPluginHost = (
  environment: PluginHostEnvironment,
): PluginHost => {
  let config: PluginHostConfig | null = null;
  /** Hooks and API by plugin, so a plugin configured again is not set up twice. */
  const setUpPlugins = new WeakMap<
    HotUpdaterClientPlugin,
    { readonly hooks: HotUpdaterClientHooks; readonly api: unknown }
  >();
  let activePlugins: readonly {
    readonly plugin: HotUpdaterClientPlugin;
    readonly hooks: HotUpdaterClientHooks;
  }[] = [];
  /** What plugins read and wrote, so a read follows a write before native does. */
  const storageValues = new Map<string, string | null>();

  const reportHookError = (message: string, error: unknown) => {
    const report = new Error(`[HotUpdater] ${message}`, { cause: error });
    try {
      if (config?.onError) {
        config.onError(report);
        return;
      }
    } catch {
      // A throwing onError must not break the update path either.
    }
    console.warn(report.message, error);
  };

  const fetchFromServer = async (
    path: string,
    init: RequestInit = {},
  ): Promise<Response> => {
    if (config === null) {
      throw new Error(
        "[HotUpdater] Plugins can fetch only after HotUpdater.init.",
      );
    }
    if (/^[a-z][a-z\d+.-]*:/i.test(path) || path.startsWith("//")) {
      throw new TypeError(
        "[HotUpdater] Plugin fetch takes a path relative to baseURL.",
      );
    }
    const { requestHeaders, requestTimeout } = config;
    const url = `${await resolveBaseURL(config.baseURL)}/${path.replace(/^\/+/, "")}`;
    const headers = new Headers(requestHeaders);
    new Headers(init.headers).forEach((value, name) => {
      headers.set(name, value);
    });

    const controller = new AbortController();
    const callerSignal = init.signal;
    const abortFromCaller = () => controller.abort();
    if (callerSignal?.aborted) controller.abort();
    callerSignal?.addEventListener("abort", abortFromCaller);
    let timedOut = false;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, requestTimeout ?? 5000);

    try {
      return await environment.fetch(url, {
        ...init,
        headers,
        signal: controller.signal,
      });
    } catch (error: unknown) {
      // Whatever the fetch rejects with once the timeout aborts it: an
      // AbortError or a host-specific fetch cancellation error.
      if (
        !callerSignal?.aborted &&
        (timedOut || (error instanceof Error && error.name === "AbortError"))
      ) {
        throw new Error("Request timed out");
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
      callerSignal?.removeEventListener("abort", abortFromCaller);
    }
  };

  const createStorage = (pluginId: string): HotUpdaterClientStorage => {
    const scopedKey = (key: string) => {
      if (typeof key !== "string" || key.length === 0) {
        throw new TypeError(
          "[HotUpdater] Plugin storage keys are non-empty strings.",
        );
      }
      return pluginStorageKey(pluginId, key);
    };

    return {
      get: (key) => {
        const storageKey = scopedKey(key);
        const cached = storageValues.get(storageKey);
        if (cached !== undefined) return cached;
        const value = environment.getStorageItem(storageKey);
        storageValues.set(storageKey, value);
        return value;
      },
      set: (key, value) => {
        const storageKey = scopedKey(key);
        if (value !== null && typeof value !== "string") {
          throw new TypeError(
            "[HotUpdater] Plugin storage values are strings or null.",
          );
        }
        if (value !== null && value.length > MAX_STORAGE_VALUE_LENGTH) {
          throw new RangeError(
            "[HotUpdater] Plugin storage values are at most 64 KB.",
          );
        }
        environment.setStorageItem(storageKey, value);
        storageValues.set(storageKey, value);
      },
    };
  };

  const createContext = (pluginId: string): HotUpdaterClientContext => ({
    fetch: fetchFromServer,
    get installId() {
      return environment.getInstallId();
    },
    platform: environment.platform,
    get appVersion() {
      return environment.getAppVersion();
    },
    get sdkVersion() {
      return environment.sdkVersion;
    },
    get minBundleId() {
      return environment.getMinBundleId();
    },
    isDebugBuild: environment.isDebugBuild,
    getBundleId: () => environment.getBundleId(),
    getChannel: () => environment.getChannel(),
    getCohort: () => environment.getCohort(),
    getFingerprintHash: () => environment.getFingerprintHash(),
    storage: createStorage(pluginId),
    now: () => environment.now(),
  });

  const setUpPlugin = (
    plugin: HotUpdaterClientPlugin,
  ): { readonly hooks: HotUpdaterClientHooks; readonly api: unknown } => {
    let result: HotUpdaterClientSetup | void;
    try {
      result = plugin.setup(createContext(plugin.id));
    } catch (error) {
      reportHookError(`Plugin "${plugin.id}" failed in setup`, error);
      return { hooks: {}, api: undefined };
    }
    if (result === undefined || result === null) {
      return { hooks: {}, api: undefined };
    }
    const unknownKeys = Object.keys(result).filter(
      (key) => key !== "hooks" && key !== "api",
    );
    if (unknownKeys.length > 0) {
      // A plugin written for the contract that returned hooks directly.
      reportHookError(
        `Plugin "${plugin.id}" setup returned ${unknownKeys.map((key) => `"${key}"`).join(", ")}; setup returns { hooks, api }`,
        new TypeError("Unexpected setup result"),
      );
    }
    return { hooks: result.hooks ?? {}, api: result.api };
  };

  const configurePlugins: PluginHost["configurePlugins"] = (
    plugins,
    nextConfig,
  ) => {
    const ids = new Set<string>();
    for (const plugin of plugins ?? []) {
      if (typeof plugin.id !== "string" || plugin.id.length === 0) {
        throw new Error("[HotUpdater] A plugin id must be a non-empty string.");
      }
      if (ids.has(plugin.id)) {
        throw new Error(
          `[HotUpdater] Two plugins use the id "${plugin.id}". Plugin ids must be unique.`,
        );
      }
      ids.add(plugin.id);
    }

    config = nextConfig;
    const apis: [string, unknown][] = [];
    activePlugins = (plugins ?? []).map((plugin) => {
      let setUp = setUpPlugins.get(plugin);
      if (setUp === undefined) {
        setUp = setUpPlugin(plugin);
        setUpPlugins.set(plugin, setUp);
      }
      if (setUp.api !== undefined) apis.push([plugin.id, setUp.api]);
      return { plugin, hooks: setUp.hooks };
    });
    // Own properties for every id: assigning `__proto__` would set the prototype.
    return Object.freeze(Object.fromEntries(apis));
  };

  const hasPluginHook: PluginHost["hasPluginHook"] = (name) =>
    activePlugins.some(({ hooks }) => typeof hooks[name] === "function");

  const buildPluginEvent: PluginHost["buildPluginEvent"] = (
    name,
    createPayload,
  ) => {
    if (!hasPluginHook(name)) return null;
    try {
      return createPayload();
    } catch (error) {
      reportHookError(`Failed to build the ${name} event for plugins`, error);
      return null;
    }
  };

  const dispatchPluginHook: PluginHost["dispatchPluginHook"] = <
    K extends PluginHookName,
  >(
    name: K,
    payload: PluginHookPayload<K>,
  ) => {
    const settlements: Promise<void>[] = [];
    for (const { plugin, hooks } of activePlugins) {
      const hook = hooks[name] as
        | ((payload: PluginHookPayload<K>) => unknown)
        | undefined;
      if (typeof hook !== "function") continue;
      try {
        const result = hook.call(hooks, payload);
        if (
          result !== null &&
          typeof result === "object" &&
          typeof (result as PromiseLike<unknown>).then === "function"
        ) {
          settlements.push(
            Promise.resolve(result).then(
              () => undefined,
              (error: unknown) => {
                reportHookError(
                  `Plugin "${plugin.id}" failed in ${name}`,
                  error,
                );
              },
            ),
          );
        }
      } catch (error) {
        reportHookError(`Plugin "${plugin.id}" failed in ${name}`, error);
      }
    }
    return settlements;
  };

  const emitPluginHook: PluginHost["emitPluginHook"] = (
    name,
    createPayload,
  ) => {
    const payload = buildPluginEvent(name, createPayload);
    if (payload !== null) dispatchPluginHook(name, payload);
  };

  return {
    configurePlugins,
    hasPluginHook,
    buildPluginEvent,
    dispatchPluginHook,
    emitPluginHook,
  };
};
