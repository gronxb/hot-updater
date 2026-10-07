import { emitAfterAppReady } from "./appReady";
import {
  type CheckForUpdateOptions,
  checkForUpdate,
  reportUpdateError,
} from "./checkForUpdate";
import type { ClientPluginApis, HotUpdaterClientPlugin } from "./clientPlugin";
import { createHttpClient, type HotUpdaterHttpClient } from "./httpClient";
import {
  type HotUpdaterInitOptions,
  init,
  type InternalInitOptions,
} from "./init";
import {
  addListener,
  getPublicActiveUpdateState,
  getActiveUpdateState,
  getBundleId,
  clearCrashHistory,
  getAppVersion,
  getBaseURL,
  getUpdateId,
  getChannel,
  getCohort,
  getCrashHistory,
  getDefaultChannel,
  getFingerprintHash,
  getInstallId,
  getManifest,
  getMinBundleId,
  isChannelSwitched,
  notifyAppReady,
  reload,
  resetChannel,
  setCohort,
  setReloadBehavior,
  stageBundle,
  type UpdateParams,
} from "./native";
import { configurePlugins } from "./pluginHost";
import { hotUpdaterStore } from "./store";
import { type HotUpdaterWrapOptions, wrap } from "./wrap";

export {
  defineClientPlugin,
  type AppReadyResult,
  type BundleDownloadedInfo,
  type ClientPluginApi,
  type ClientPluginApis,
  type HotUpdaterClientContext,
  type HotUpdaterClientHooks,
  type HotUpdaterClientPlugin,
  type HotUpdaterClientSetup,
  type HotUpdaterClientStorage,
  type ReleaseTransitionKind,
  type UpdateCheckResult,
  type UpdateError,
  type UpdateErrorReason,
  type UpdateErrorStage,
  type UpdateHttpResponse,
  type UpdateStrategy,
} from "./clientPlugin";
// The built-in Insights client plugin, for HotUpdater.init({ plugins }).
export {
  insights,
  type InsightsClient,
  type InsightsOptions,
  type InsightsPlugin,
  type InsightsUser,
} from "@hot-updater/plugin-insights/client";
// The built-in Remote Config client plugin, for HotUpdater.init({ plugins }).
export {
  remoteConfig,
  type RemoteConfigClient,
  type RemoteConfigDefaults,
  type RemoteConfigDefaultValue,
  type RemoteConfigFetchStatus,
  type RemoteConfigKey,
  type RemoteConfigOptions,
  type RemoteConfigPlugin,
  type RemoteConfigValue,
  type RemoteConfigValueSource,
} from "@hot-updater/plugin-remote-config/client";
export type {
  CustomReloadHandler,
  HotUpdaterEvent,
  HotUpdaterProgressArtifactType,
  HotUpdaterProgressEvent,
  Manifest,
  ManifestAsset,
  NotifyAppReadyResult,
  ActiveUpdateState,
  ReloadBehavior,
  ReloadBehaviorSetting,
} from "./native";
export * from "./store";
export {
  extractSignatureFailure,
  type HotUpdaterBaseURL,
  isSignatureVerificationError,
  type SignatureVerificationFailure,
} from "./types";
export type { HotUpdaterInitOptions } from "./init";
export type {
  HotUpdaterFallbackComponentProps,
  HotUpdaterWrapOptions,
  RunUpdateProcessResponse,
} from "./wrap";

/**
 * Register getBaseURL to global objects for use without imports.
 * This is needed for Expo DOM components and Babel plugin generated code.
 */
const registerGlobalGetBaseURL = () => {
  const fn = getBaseURL;

  // Register to globalThis (modern, cross-platform)
  if (typeof globalThis !== "undefined") {
    if (!globalThis.HotUpdaterGetBaseURL) {
      globalThis.HotUpdaterGetBaseURL = fn;
    }
  }
};

// Call registration immediately on module load
registerGlobalGetBaseURL();

/** The configuration of the latest `HotUpdater.init`, which every instance reads. */
interface ClientConfig {
  readonly client: HotUpdaterHttpClient;
  readonly requestHeaders?: Record<string, string>;
  readonly requestTimeout?: number;
  readonly onError?: (error: unknown) => void;
  /** Settles once `init` has read this launch. */
  readonly appReady: Promise<unknown>;
}

// HotUpdater.init sets this before it returns an instance, so an instance's
// methods always find it. A later init replaces it for every instance.
let latest: ClientConfig;

const createMissingNetworkConfigError = () =>
  new Error(
    `[HotUpdater] baseURL must be provided.\n\n` +
      `Configure HotUpdater with the standard baseURL setup:\n\n` +
      `  export const hotUpdater = HotUpdater.init({\n` +
      `    baseURL: "<your-update-server-url>",\n` +
      `  });\n\n` +
      `See https://hot-updater.dev/docs/react-native-api/init`,
  );

const normalizeInitOptions = (
  options: HotUpdaterInitOptions,
): InternalInitOptions => {
  const { updateMode: _updateMode, ...rest } =
    options as HotUpdaterInitOptions & {
      updateMode?: unknown;
    };

  if (rest.baseURL) {
    const { baseURL, plugins: _plugins, ...baseURLRest } = rest;
    return {
      ...baseURLRest,
      client: createHttpClient(baseURL, (response) => {
        emitAfterAppReady("onHttpResponse", () => response);
      }),
    };
  }

  throw createMissingNetworkConfigError();
};

const checkForUpdateWithConfig = (options: CheckForUpdateOptions) =>
  checkForUpdate({
    ...options,
    client: latest.client,
    requestHeaders: {
      ...latest.requestHeaders,
      ...options.requestHeaders,
    },
    requestTimeout: options.requestTimeout ?? latest.requestTimeout,
    onError: options.onError ?? latest.onError,
  });

const core = {
  /**
   * Reloads the app.
   */
  reload,

  /**
   * Configures how `hotUpdater.reload()` behaves.
   *
   * This can be called unconditionally on both platforms.
   * The default is `processRestart`.
   *
   * - `reload`: built-in React Native reload on both platforms
   * - `processRestart`: Android process restart, iOS behaves like normal reload
   * - `custom`: run a custom JS handler on both platforms
   */
  setReloadBehavior,

  /**
   * Returns whether an update has finished downloading in this app session.
   *
   * When it returns true, calling `hotUpdater.reload()` (or restarting the app)
   * will apply the downloaded update bundle.
   *
   * - Derived from `progress` reaching 1.0
   * - Resets to false when a new download starts (progress < 1)
   *
   * @returns {boolean} True if a downloaded update is ready to apply
   * @example
   * ```ts
   * if (hotUpdater.isUpdateDownloaded()) {
   *   await hotUpdater.reload();
   * }
   * ```
   */
  isUpdateDownloaded: () => hotUpdaterStore.getSnapshot().isUpdateDownloaded,

  /**
   * Fetches the current app version.
   */
  getAppVersion,

  /** Reads the active and stable Release/Bundle state. */
  getActiveUpdateState: async () => getPublicActiveUpdateState(),

  /**
   * Returns the selected update ID, matching the ID shown in the console.
   * A staged update can change this ID before the app reloads.
   */
  getBundleId: getUpdateId,

  /** Returns the minimum bundle ID based on the native app build time. */
  getMinBundleId,

  /**
   * Fetches the current manifest for the active bundle.
   */
  getManifest,

  /**
   * Fetches the current channel of the app.
   *
   * If no channel is specified, the app is assigned to the 'production' channel.
   *
   * @returns {string} The current release channel of the app
   * @default "production"
   * @example
   * ```ts
   * const channel = hotUpdater.getChannel();
   * console.log(`Current channel: ${channel}`);
   * ```
   */
  getChannel,

  /**
   * Fetches the build-time default channel of the app.
   *
   * This value does not change when a runtime channel override is active.
   *
   * @returns {string} The default release channel embedded in the app
   * @example
   * ```ts
   * const defaultChannel = hotUpdater.getDefaultChannel();
   * console.log(`Default channel: ${defaultChannel}`);
   * ```
   */
  getDefaultChannel,

  /**
   * Returns whether the app is currently using a runtime channel override.
   *
   * @returns {boolean} true when a non-default channel has been applied
   */
  isChannelSwitched,

  /**
   * Sets the persisted cohort used for rollout calculations.
   * Call `getCohort()` first if you need to restore the initial value later.
   */
  setCohort,

  /**
   * Gets the persisted cohort used for rollout calculations.
   */
  getCohort,

  /**
   * Adds a listener to HotUpdater events.
   *
   * @param {keyof HotUpdaterEvent} eventName - The name of the event to listen for
   * @param {(event: HotUpdaterEvent[T]) => void} listener - The callback function to handle the event
   * @returns {() => void} A cleanup function that removes the event listener
   *
   * @example
   * ```ts
   * const unsubscribe = hotUpdater.addListener("onProgress", ({ progress }) => {
   *   console.log(`Update progress: ${progress * 100}%`);
   * });
   *
   * // Unsubscribe when no longer needed
   * unsubscribe();
   * ```
   */
  addListener,

  /**
   * Checks for an update, with the server and request settings of
   * `HotUpdater.init`.
   *
   * @param {Object} config - Update check configuration
   * @param {string} [config.channel] - Optional channel override for this update check
   * @param {Record<string, string>} [config.requestHeaders] - Request headers
   *
   * @returns {Promise<CheckForUpdateResult | null>} Update information or null if up to date
   *
   * @example
   * ```ts
   * const updateInfo = await hotUpdater.checkForUpdate({
   *   updateStrategy: "appVersion",
   *   requestHeaders: {
   *     "x-api-key": "<your-api-key>",
   *   },
   * });
   *
   * if (!updateInfo) {
   *   console.log("App is up to date");
   *   return;
   * }
   *
   * await updateInfo.updateBundle();
   * if (updateInfo.shouldForceUpdate) {
   *   await hotUpdater.reload();
   * }
   * ```
   */
  checkForUpdate: checkForUpdateWithConfig,

  /**
   * Updates the bundle of the app.
   *
   * @param {UpdateBundleParams} params - Parameters object required for bundle update
   * @param {string} params.bundleId - The bundle ID of the app
   * @returns {Promise<boolean>} Whether the update was successful
   *
   * @example
   * ```ts
   * const updateInfo = await hotUpdater.checkForUpdate({
   *   updateStrategy: "appVersion",
   *   requestHeaders: {
   *     "x-api-key": "<your-api-key>",
   *   },
   * });
   *
   * if (!updateInfo) {
   *   return {
   *     status: "UP_TO_DATE",
   *   };
   * }
   *
   * await updateInfo.updateBundle();
   * if (updateInfo.shouldForceUpdate) {
   *   await hotUpdater.reload();
   * }
   * ```
   */
  updateBundle: async (params: UpdateParams) => {
    const fromBundleId = getBundleId();
    const state = getActiveUpdateState();
    const active = state.activeSelection;
    const fromReleaseId =
      active?.bundleId === fromBundleId
        ? active.releaseId
        : state.stableSelection?.bundleId === fromBundleId
          ? state.stableSelection.releaseId
          : null;
    const channel = params.channel ?? getChannel();
    const strategyOf = (scopeKey: string | null | undefined) =>
      scopeKey?.startsWith("v1:fingerprint:") ? "fingerprint" : "appVersion";
    let delivery: Awaited<ReturnType<typeof stageBundle>>;
    try {
      delivery = await stageBundle(params);
    } catch (error) {
      reportUpdateError(error, "download", undefined, {
        bundleId: fromBundleId,
        channel,
        targetBundleId: params.bundleId,
        targetReleaseId:
          (params.selection as { releaseId?: string | null } | undefined)
            ?.releaseId ?? null,
        updateStrategy: strategyOf(
          (params.selection as { scopeKey?: string | null } | undefined)
            ?.scopeKey,
        ),
      });
      throw error;
    }
    if (delivery !== null && params.bundleId !== fromBundleId) {
      emitAfterAppReady("onBundleDownloaded", () => {
        const selection = getActiveUpdateState().activeSelection;
        return {
          channel,
          fromBundleId,
          fromReleaseId,
          toBundleId: params.bundleId,
          toReleaseId: selection?.releaseId ?? null,
          updateStrategy: strategyOf(selection?.scopeKey),
          ...delivery,
        };
      });
    }
    return true;
  },

  /**
   * Clears the runtime channel override and restores the original bundle.
   *
   * @returns {Promise<boolean>} Resolves with true if reset was successful
   */
  resetChannel: async () => {
    const ok = await resetChannel();
    if (ok) {
      hotUpdaterStore.setState({
        artifactType: null,
        details: null,
        isUpdateDownloaded: false,
        progress: 0,
      });
    }
    return ok;
  },

  /**
   * Fetches the fingerprint of the app.
   *
   * @returns {string} The fingerprint of the app
   *
   * @example
   * ```ts
   * const fingerprint = hotUpdater.getFingerprintHash();
   * console.log(`Fingerprint: ${fingerprint}`);
   * ```
   */
  getFingerprintHash,

  /**
   * Fetches the persisted install id for this app installation.
   */
  getInstallId,

  /**
   * Reads the native launch report for the current process.
   */
  notifyAppReady,

  /**
   * Gets the list of bundle IDs that have been marked as crashed.
   * These bundles will be rejected if attempted to install again.
   *
   * @returns {string[]} Array of crashed bundle IDs
   *
   * @example
   * ```ts
   * const crashedBundles = hotUpdater.getCrashHistory();
   * console.log("Crashed bundles:", crashedBundles);
   * ```
   */
  getCrashHistory,

  /**
   * Clears the crashed bundle history, allowing previously crashed bundles
   * to be installed again.
   *
   * @returns {boolean} true if clearing was successful
   *
   * @example
   * ```ts
   * // Clear crash history to allow retrying a previously failed bundle
   * hotUpdater.clearCrashHistory();
   * ```
   */
  clearCrashHistory,
};

const instanceMethods = {
  ...core,

  /**
   * Wraps the app's root: when it mounts, it checks for an update with the
   * configuration of `HotUpdater.init`, downloads one, and reloads for a
   * forced update. A `fallbackComponent` replaces the root until the check
   * and a forced update finish.
   *
   * @example
   * ```tsx
   * export default hotUpdater.wrap({
   *   updateStrategy: "appVersion",
   *   fallbackComponent: ({ progress }) => <Splash progress={progress} />,
   * })(App);
   * ```
   */
  wrap: (options: HotUpdaterWrapOptions) =>
    wrap({
      ...options,
      checkForUpdate: checkForUpdateWithConfig,
      appReady: () => latest.appReady,
      onError: (error) => latest.onError?.(error),
    }),
};

/** Names a plugin id cannot take: the instance's own members, and `init`. */
const reservedIds: ReadonlySet<string> = new Set([
  ...Object.keys(instanceMethods),
  "init",
]);

/** The methods of every instance `HotUpdater.init` returns. */
export type HotUpdaterCore = typeof instanceMethods;

/**
 * The instance `HotUpdater.init` returns: HotUpdater's methods, and each
 * plugin's API under the plugin's id.
 */
export type HotUpdaterInstance<
  TPlugins extends readonly HotUpdaterClientPlugin[] = readonly [],
> = Readonly<HotUpdaterCore> & ClientPluginApis<TPlugins>;

export const HotUpdater = {
  /**
   * Initializes HotUpdater: the update server, its request settings, and
   * the client plugins. Call it once, at the top level of a module, and
   * export the instance it returns. Calling it again replaces the
   * configuration.
   *
   * The instance has every HotUpdater method, such as `wrap`,
   * `checkForUpdate`, and `reload`, and each plugin's API under the
   * plugin's id, such as `hotUpdater.remoteConfig` for `remoteConfig()`.
   *
   * @example
   * ```tsx
   * export const hotUpdater = HotUpdater.init({
   *   baseURL: "<your-update-server-url>",
   *   plugins: [remoteConfig({ defaults: { welcome_message: "Hi" } })],
   * });
   *
   * hotUpdater.remoteConfig.getString("welcome_message");
   * ```
   */
  init: <
    const TPlugins extends readonly HotUpdaterClientPlugin[] = readonly [],
  >(
    options: HotUpdaterInitOptions<TPlugins>,
  ): HotUpdaterInstance<TPlugins> => {
    const normalizedOptions = normalizeInitOptions(options);
    for (const plugin of options.plugins ?? []) {
      if (reservedIds.has(plugin.id)) {
        throw new Error(
          `[HotUpdater] A plugin cannot use the id "${plugin.id}": the HotUpdater instance has its own "${plugin.id}".`,
        );
      }
    }

    // Plugins are set up before init reads the launch they observe.
    const apis = configurePlugins(options.plugins, {
      baseURL: options.baseURL,
      requestHeaders: options.requestHeaders,
      requestTimeout: options.requestTimeout,
      onError: options.onError,
    });
    latest = {
      client: normalizedOptions.client,
      requestHeaders: options.requestHeaders,
      requestTimeout: options.requestTimeout,
      onError: options.onError,
      appReady: init(normalizedOptions),
    };
    return Object.freeze({
      ...instanceMethods,
      ...apis,
    }) as HotUpdaterInstance<TPlugins>;
  },
};
