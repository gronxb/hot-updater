/**
 * Runs client plugins in tests the way the SDK runs them in an app, against
 * an in-memory device and a server the test answers.
 *
 * ```ts
 * import { setupClientPlugin } from "@hot-updater/test-utils/react-native";
 *
 * const runtime = setupClientPlugin(myPlugin());
 * runtime.hooks.onAppReady(launch);
 * await runtime.settled();
 * expect(runtime.requests[0]?.json()).toEqual(expectedEvent);
 * ```
 *
 * It sets plugins up with the plugin host from `@hot-updater/protocol`,
 * the same code the app runs, so they get the same context and rules:
 * unique ids, `setup` once per runtime, storage scoped to the plugin's id
 * with values up to 64 KB, `fetch` relative to `baseURL` with
 * `requestHeaders` and `requestTimeout`, and hooks the SDK never waits for,
 * whose throws and rejections are reported, not raised. It imports neither
 * React Native nor a test runner, so it works under Vitest and Jest.
 */
import {
  createPluginHost,
  pluginStorageKey,
  resolveBaseURL,
  type AppReadyResult,
  type BundleDownloadedInfo,
  type HotUpdaterBaseURL,
  type HotUpdaterClientPlugin,
  type PluginHookName,
  type PluginHookPayload,
  type UpdateCheckResult,
  type UpdateError,
} from "@hot-updater/protocol";

/** A value the test fixes, or reads each time a plugin asks for it. */
type TestValue<T> = T | (() => T);

export interface ClientPluginTestOptions {
  /** The server plugins fetch from. Default: `https://hot-updater.example.com`. */
  readonly baseURL?: HotUpdaterBaseURL;
  /** Headers the SDK adds to every plugin request, as `init` and `wrap` take them. */
  readonly requestHeaders?: Record<string, string>;
  /** Milliseconds before a plugin request fails with `Request timed out`. Default: 5000. */
  readonly requestTimeout?: number;
  /**
   * Answers each plugin request. Default: `204 No Content`. Throw or reject
   * to fail the request the way a network error does.
   */
  readonly respond?: (
    request: ClientPluginTestRequest,
  ) => Response | Promise<Response>;
  /** Default: `00000000-0000-4000-8000-000000000000`. */
  readonly installId?: TestValue<string>;
  /** Default: `ios`. */
  readonly platform?: "ios" | "android";
  /** The native app version. Default: `1.0.0`. */
  readonly appVersion?: TestValue<string | null>;
  /** Default: `0.0.0-test`. */
  readonly sdkVersion?: string;
  /** Default: false. */
  readonly isDebugBuild?: boolean;
  /** The running bundle. Default: `00000000-0000-0000-0000-000000000000`. */
  readonly bundleId?: TestValue<string>;
  /** Default: `production`. */
  readonly channel?: TestValue<string>;
  /** Default: `1`. */
  readonly cohort?: TestValue<string>;
  /** Default: null. */
  readonly fingerprintHash?: TestValue<string | null>;
  /** The clock plugins read. Default: `Date.now()`, so fake timers move it. */
  readonly now?: () => number;
  /**
   * The device's plugin storage. Pass an earlier runtime's `storage` to set
   * the plugins up again on the same device, as a relaunch does.
   */
  readonly storage?: ClientPluginTestStorage;
}

/** A request a plugin made with `context.fetch`, as the server receives it. */
export interface ClientPluginTestRequest {
  readonly url: string;
  /** The URL after `baseURL`, such as `/events`. */
  readonly path: string;
  readonly method: string;
  /** Lowercase header names, `requestHeaders` included. */
  readonly headers: Readonly<Record<string, string>>;
  /** The body as text, or null without one. */
  readonly body: string | null;
  /** The body parsed as JSON. */
  json<T = unknown>(): T;
}

/** A device's plugin storage, which outlives a runtime as native storage does. */
export interface ClientPluginTestStorage {
  /** What a plugin stored under `key`, or null. */
  get(pluginId: string, key: string): string | null;
  /** Stores a value for a plugin, as an earlier launch would have; `null` removes it. */
  set(pluginId: string, key: string, value: string | null): void;
  /** Every key and value a plugin stored. */
  entries(pluginId: string): Record<string, string>;
}

/** The hooks the SDK calls, called the same way. */
export interface ClientPluginTestHooks {
  onAppReady(result: AppReadyResult): void;
  onUpdateCheck(result: UpdateCheckResult): void;
  onBundleDownloaded(info: BundleDownloadedInfo): void;
  onUpdateError(error: UpdateError): void;
}

/** One JavaScript runtime with the plugins set up, as after `HotUpdater.init`. */
export interface ClientPluginTestRuntime {
  /**
   * Calls a hook on every plugin that returned it, as the SDK does: without
   * waiting for it, and with a throw or rejection recorded in `errors`
   * instead of raised. Await `settled()` for what the hooks started.
   */
  readonly hooks: ClientPluginTestHooks;
  /** Whether any plugin returned this hook from `setup`. */
  listens(name: keyof ClientPluginTestHooks): boolean;
  /** The requests plugins made, in order. */
  readonly requests: readonly ClientPluginTestRequest[];
  readonly storage: ClientPluginTestStorage;
  /**
   * What the SDK reported to `onError`: each `setup` or hook that threw or
   * rejected, with the plugin's error as `cause`.
   */
  readonly errors: readonly Error[];
  /**
   * Resolves once the hooks called so far, and the requests they started,
   * have settled. It does not run timers: with fake timers, advance them to
   * reach a retry or a delay.
   */
  settled(): Promise<void>;
}

const storageItems = new WeakMap<
  ClientPluginTestStorage,
  Map<string, string>
>();

/** A new device's empty plugin storage. */
export const createTestStorage = (): ClientPluginTestStorage => {
  const items = new Map<string, string>();
  const storage: ClientPluginTestStorage = {
    get: (pluginId, key) => items.get(pluginStorageKey(pluginId, key)) ?? null,
    set: (pluginId, key, value) => {
      if (value !== null && typeof value !== "string") {
        throw new TypeError(
          "[HotUpdater] Plugin storage values are strings or null.",
        );
      }
      const storageKey = pluginStorageKey(pluginId, key);
      if (value === null) items.delete(storageKey);
      else items.set(storageKey, value);
    },
    entries: (pluginId) => {
      const prefix = pluginStorageKey(pluginId, "");
      return Object.fromEntries(
        [...items]
          .filter(([storageKey]) => storageKey.startsWith(prefix))
          .map(([storageKey, value]) => [
            storageKey.slice(prefix.length),
            value,
          ]),
      );
    },
  };
  storageItems.set(storage, items);
  return storage;
};

const read = <T>(value: TestValue<T>): T =>
  typeof value === "function" ? (value as () => T)() : value;

const abortError = (signal: AbortSignal | null | undefined): Error => {
  // React Native's AbortSignal type has no `reason`; Node's signal does.
  const reason = (signal as { readonly reason?: unknown } | null | undefined)
    ?.reason;
  if (reason instanceof Error && reason.name === "AbortError") return reason;
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
};

/** The part of `MessageChannel` it uses; React Native's types have none. */
interface MessageChannelLike {
  readonly port1: {
    addEventListener(
      type: "message",
      listener: () => void,
      options: { readonly once: boolean },
    ): void;
    start(): void;
    close(): void;
  };
  readonly port2: { postMessage(message: null): void };
}

/**
 * Resolves after every pending microtask, on a macrotask that fake timers
 * leave alone.
 */
const nextMacrotask = () =>
  new Promise<void>((resolve) => {
    const Channel = (
      globalThis as { readonly MessageChannel?: new () => MessageChannelLike }
    ).MessageChannel;
    if (Channel === undefined) {
      setTimeout(resolve, 0);
      return;
    }
    const { port1, port2 } = new Channel();
    port1.addEventListener(
      "message",
      () => {
        port1.close();
        resolve();
      },
      { once: true },
    );
    port1.start();
    port2.postMessage(null);
  });

/** Sets plugins up as `HotUpdater.init({ plugins })` does, in a new runtime. */
export const setupClientPlugins = (
  plugins: readonly HotUpdaterClientPlugin[],
  options: ClientPluginTestOptions = {},
): ClientPluginTestRuntime => {
  const storage = options.storage ?? createTestStorage();
  const items = storageItems.get(storage);
  if (items === undefined) {
    throw new TypeError(
      "[HotUpdater] Pass a storage from createTestStorage() or an earlier runtime.",
    );
  }
  const baseURL = options.baseURL ?? "https://hot-updater.example.com";
  const respond =
    options.respond ?? (() => new Response(null, { status: 204 }));
  const requests: ClientPluginTestRequest[] = [];
  const errors: Error[] = [];
  const pending = new Set<Promise<void>>();

  const track = (work: Promise<unknown>) => {
    const settledWork: Promise<void> = work
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        pending.delete(settledWork);
      });
    pending.add(settledWork);
  };

  const recordRequest = async (
    url: string,
    init: RequestInit,
  ): Promise<ClientPluginTestRequest> => {
    // Built as fetch builds it, so a request fetch refuses, such as a GET
    // with a body, fails here too.
    const request = new Request(url, init);
    const body =
      typeof init.body === "string"
        ? init.body
        : init.body === undefined || init.body === null
          ? null
          : await request.text();
    const base = await resolveBaseURL(baseURL);
    const headers: Record<string, string> = {};
    request.headers.forEach((value, name) => {
      headers[name] = value;
    });
    return {
      url,
      path: url.startsWith(`${base}/`) ? url.slice(base.length) : url,
      method: request.method,
      headers,
      body,
      json: <T>() => {
        if (body === null) {
          throw new SyntaxError("The request has no body to parse as JSON.");
        }
        return JSON.parse(body) as T;
      },
    };
  };

  const answer = (
    request: ClientPluginTestRequest,
    signal: AbortSignal | null | undefined,
  ) =>
    new Promise<Response>((resolve, reject) => {
      const abort = () => reject(abortError(signal));
      if (signal?.aborted) {
        abort();
        return;
      }
      signal?.addEventListener("abort", abort, { once: true });
      Promise.resolve()
        .then(() => respond(request))
        .then(resolve, reject)
        .finally(() => signal?.removeEventListener("abort", abort));
    });

  const host = createPluginHost({
    fetch: (url, init) => {
      const response = recordRequest(url, init).then((request) => {
        requests.push(request);
        return answer(request, init.signal);
      });
      track(response);
      return response;
    },
    platform: options.platform ?? "ios",
    isDebugBuild: options.isDebugBuild ?? false,
    sdkVersion: options.sdkVersion ?? "0.0.0-test",
    getInstallId: () =>
      read(options.installId ?? "00000000-0000-4000-8000-000000000000"),
    getAppVersion: () =>
      read(options.appVersion === undefined ? "1.0.0" : options.appVersion),
    getBundleId: () =>
      read(options.bundleId ?? "00000000-0000-0000-0000-000000000000"),
    getChannel: () => read(options.channel ?? "production"),
    getCohort: () => read(options.cohort ?? "1"),
    getFingerprintHash: () =>
      read(
        options.fingerprintHash === undefined ? null : options.fingerprintHash,
      ),
    getStorageItem: (key) => items.get(key) ?? null,
    setStorageItem: (key, value) => {
      if (value === null) items.delete(key);
      else items.set(key, value);
    },
    now: () => (options.now ? options.now() : Date.now()),
  });

  host.configurePlugins(plugins, {
    baseURL,
    requestHeaders: options.requestHeaders,
    requestTimeout: options.requestTimeout,
    onError: (error) => {
      errors.push(error as Error);
    },
  });

  const call =
    <K extends PluginHookName>(name: K) =>
    (payload: PluginHookPayload<K>): void => {
      for (const settlement of host.dispatchPluginHook(name, payload)) {
        track(settlement);
      }
    };

  return {
    hooks: {
      onAppReady: call("onAppReady"),
      onUpdateCheck: call("onUpdateCheck"),
      onBundleDownloaded: call("onBundleDownloaded"),
      onUpdateError: call("onUpdateError"),
    },
    listens: (name) => host.hasPluginHook(name),
    requests,
    storage,
    errors,
    settled: async () => {
      for (;;) {
        await nextMacrotask();
        if (pending.size === 0) return;
        await Promise.all(pending);
      }
    },
  };
};

/** Sets one plugin up; see `setupClientPlugins`. */
export const setupClientPlugin = (
  plugin: HotUpdaterClientPlugin,
  options?: ClientPluginTestOptions,
): ClientPluginTestRuntime => setupClientPlugins([plugin], options);
