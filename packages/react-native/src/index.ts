import { emitAfterAppReady } from "./appReady";
import {
  type CheckForUpdateOptions,
  checkForUpdate,
  type InternalCheckForUpdateOptions,
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

/**
 * Creates a HotUpdater client instance with all update management methods.
 * This function is called once on module initialization to create a singleton instance.
 */
function createHotUpdaterClient() {
  // Global configuration stored from init
  const globalConfig: {
    client: HotUpdaterHttpClient | null;
    requestHeaders?: Record<string, string>;
    requestTimeout?: number;
    onError?: (error: unknown) => void;
  } = {
    client: null,
  };

  const createMissingNetworkConfigError = () =>
    new Error(
      `[HotUpdater] baseURL must be provided.\n\n` +
        `Configure HotUpdater before calling update APIs with the standard baseURL setup:\n\n` +
        `  HotUpdater.init({\n` +
        `    baseURL: "<your-update-server-url>",\n` +
        `  });\n\n` +
        `For update flows, visit: https://hot-updater.dev/docs/guides/custom-update`,
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

  const configureGlobal = (
    normalizedOptions: InternalInitOptions,
    options: HotUpdaterInitOptions,
  ): Readonly<Record<string, unknown>> => {
    // Plugins are set up before init reads the launch they observe.
    const apis = configurePlugins(options.plugins, {
      baseURL: options.baseURL,
      requestHeaders: options.requestHeaders,
      requestTimeout: options.requestTimeout,
      onError: options.onError,
    });
    globalConfig.client = normalizedOptions.client;
    globalConfig.requestHeaders = options.requestHeaders;
    globalConfig.requestTimeout = options.requestTimeout;
    globalConfig.onError = options.onError;
    return apis;
  };

  const ensureGlobalClient = (methodName: string) => {
    if (!globalConfig.client) {
      throw new Error(
        `[HotUpdater] ${methodName} requires HotUpdater.init() to be called first.\n\n` +
          `To fix this issue, configure HotUpdater before calling ${methodName}:\n\n` +
          `  HotUpdater.init({\n` +
          `    baseURL: "<your-update-server-url>",\n` +
          `  });\n\n` +
          `For update flows, visit: https://hot-updater.dev/docs/guides/custom-update`,
      );
    }
    return globalConfig.client;
  };

  const core = {
    /**
     * Reloads the app.
     */
    reload,

    /**
     * Configures how `HotUpdater.reload()` behaves.
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
     * When it returns true, calling `HotUpdater.reload()` (or restarting the app)
     * will apply the downloaded update bundle.
     *
     * - Derived from `progress` reaching 1.0
     * - Resets to false when a new download starts (progress < 1)
     *
     * @returns {boolean} True if a downloaded update is ready to apply
     * @example
     * ```ts
     * if (HotUpdater.isUpdateDownloaded()) {
     *   await HotUpdater.reload();
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
     * const channel = HotUpdater.getChannel();
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
     * const defaultChannel = HotUpdater.getDefaultChannel();
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
     * const unsubscribe = HotUpdater.addListener("onProgress", ({ progress }) => {
     *   console.log(`Update progress: ${progress * 100}%`);
     * });
     *
     * // Unsubscribe when no longer needed
     * unsubscribe();
     * ```
     */
    addListener,

    /**
     * Manually checks for updates.
     *
     * @param {Object} config - Update check configuration
     * @param {string} [config.channel] - Optional channel override for this update check
     * @param {Record<string, string>} [config.requestHeaders] - Request headers
     *
     * @returns {Promise<CheckForUpdateResult | null>} Update information or null if up to date
     *
     * @example
     * ```ts
     * const updateInfo = await HotUpdater.checkForUpdate({
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
     *   await HotUpdater.reload();
     * }
     * ```
     */
    checkForUpdate: (config: CheckForUpdateOptions) => {
      const client = ensureGlobalClient("checkForUpdate");

      const mergedConfig: InternalCheckForUpdateOptions = {
        ...config,
        client,
        requestHeaders: {
          ...globalConfig.requestHeaders,
          ...config.requestHeaders,
        },
        requestTimeout: config.requestTimeout ?? globalConfig.requestTimeout,
        onError: config.onError ?? globalConfig.onError,
      };

      return checkForUpdate(mergedConfig);
    },

    /**
     * Updates the bundle of the app.
     *
     * @param {UpdateBundleParams} params - Parameters object required for bundle update
     * @param {string} params.bundleId - The bundle ID of the app
     * @returns {Promise<boolean>} Whether the update was successful
     *
     * @example
     * ```ts
     * const updateInfo = await HotUpdater.checkForUpdate({
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
     *   await HotUpdater.reload();
     * }
     * ```
     */
    updateBundle: async (params: UpdateParams) => {
      ensureGlobalClient("updateBundle");
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
     * const fingerprint = HotUpdater.getFingerprintHash();
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
     * const crashedBundles = HotUpdater.getCrashHistory();
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
     * HotUpdater.clearCrashHistory();
     * ```
     */
    clearCrashHistory,
  };

  /** Names a plugin id cannot take: the instance's own members, and `init`. */
  const reservedIds: ReadonlySet<string> = new Set([
    ...Object.keys(core),
    "init",
  ]);

  return {
    ...core,

    /**
     * Initializes HotUpdater: the update server, its request settings, and
     * the client plugins. Call it once at module scope, then check for
     * updates with `HotUpdater.checkForUpdate()`.
     *
     * It returns the app's HotUpdater instance: HotUpdater's methods, and
     * each plugin's API under the plugin's id, such as
     * `hotUpdater.remoteConfig` for `remoteConfig()`. A plugin's API exists
     * only on the instance, once `init` has set the plugin up.
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
    ): HotUpdaterInstanceOf<typeof core, TPlugins> => {
      const normalizedOptions = normalizeInitOptions(options);
      for (const plugin of options.plugins ?? []) {
        if (reservedIds.has(plugin.id)) {
          throw new Error(
            `[HotUpdater] A plugin cannot use the id "${plugin.id}": the HotUpdater instance has its own "${plugin.id}".`,
          );
        }
      }

      const apis = configureGlobal(normalizedOptions, options);

      init(normalizedOptions);
      return Object.freeze({ ...core, ...apis }) as HotUpdaterInstanceOf<
        typeof core,
        TPlugins
      >;
    },
  };
}

type HotUpdaterInstanceOf<
  TCore,
  TPlugins extends readonly HotUpdaterClientPlugin[],
> = Readonly<TCore> & ClientPluginApis<TPlugins>;

export const HotUpdater = createHotUpdaterClient();

/** HotUpdater's own methods, which every instance `HotUpdater.init` returns has. */
export type HotUpdaterCore = Omit<typeof HotUpdater, "init">;

/**
 * The instance `HotUpdater.init` returns: HotUpdater's methods, and each
 * plugin's API under the plugin's id.
 */
export type HotUpdaterInstance<
  TPlugins extends readonly HotUpdaterClientPlugin[] = readonly [],
> = Readonly<HotUpdaterCore> & ClientPluginApis<TPlugins>;
