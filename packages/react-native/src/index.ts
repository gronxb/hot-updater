import { createLaunchReporter, type LaunchReporter } from "./appReady";
import {
  type CheckForUpdateOptions,
  checkForUpdate,
  reportUpdateError,
} from "./checkForUpdate";
import type { ClientPluginApis, HotUpdaterClientPlugin } from "./clientPlugin";
import { createHttpClient, type HotUpdaterHttpClient } from "./httpClient";
import type { HotUpdaterInitOptions } from "./init.types";
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
import { createAppPluginHost } from "./pluginHost";
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
  type RemoteConfigFetchOptions,
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
export type { HotUpdaterInitOptions } from "./init.types";
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

const createMissingNetworkConfigError = () =>
  new Error(
    `[HotUpdater] baseURL must be provided.\n\n` +
      `Configure HotUpdater with the standard baseURL setup:\n\n` +
      `  export const hotUpdater = HotUpdater.init({\n` +
      `    baseURL: "<your-update-server-url>",\n` +
      `  });\n\n` +
      `See https://hot-updater.dev/docs/react-native-api/init`,
  );

/** The methods that read or change native state, the same on every instance. */
const nativeMethods = {
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

/** What an instance's own methods use: its server, settings, and launch. */
interface InstanceConfig {
  readonly client: HotUpdaterHttpClient;
  readonly requestHeaders?: Record<string, string>;
  readonly requestTimeout?: number;
  readonly onError?: (error: unknown) => void;
  readonly launch: LaunchReporter;
}

/** The methods that use the instance's own configuration and plugins. */
const createConfiguredMethods = (config: InstanceConfig) => {
  const check = (options: CheckForUpdateOptions) =>
    checkForUpdate({
      ...options,
      client: config.client,
      emit: config.launch.emit,
      requestHeaders: {
        ...config.requestHeaders,
        ...options.requestHeaders,
      },
      requestTimeout: options.requestTimeout ?? config.requestTimeout,
      onError: options.onError ?? config.onError,
    });

  return {
    /**
     * Checks for an update, with this instance's server and request
     * settings.
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
    checkForUpdate: check,

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
        reportUpdateError(config.launch.emit, error, "download", undefined, {
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
        config.launch.emit("onBundleDownloaded", () => {
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
     * Wraps the app's root: when it mounts, it checks for an update with
     * this instance's configuration, downloads one, and reloads for a
     * forced update. A `fallbackComponent` replaces the root until the
     * check and a forced update finish.
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
        checkForUpdate: check,
        appReady: () => config.launch.appReady,
        onError: (error) => config.onError?.(error),
      }),
  };
};

/** The methods of every instance `HotUpdater.init` returns. */
export type HotUpdaterCore = typeof nativeMethods &
  ReturnType<typeof createConfiguredMethods>;

/**
 * The instance `HotUpdater.init` returns: HotUpdater's methods, and each
 * plugin's API under the plugin's id.
 */
export type HotUpdaterInstance<
  TPlugins extends readonly HotUpdaterClientPlugin[] = readonly [],
> = Readonly<HotUpdaterCore> & ClientPluginApis<TPlugins>;

export const HotUpdater = {
  /**
   * Creates the app's HotUpdater instance: the update server, its request
   * settings, and the client plugins. Each call returns an independent
   * instance with its own configuration and plugins, so create one, at the
   * top level of a module, and export it.
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
    const {
      baseURL,
      plugins,
      requestHeaders,
      requestTimeout,
      onError,
      onNotifyAppReady,
    } = options;
    if (!baseURL) throw createMissingNetworkConfigError();

    const host = createAppPluginHost();
    const launch = createLaunchReporter(host);
    const instance = {
      ...nativeMethods,
      ...createConfiguredMethods({
        client: createHttpClient(baseURL, (response) => {
          launch.emit("onHttpResponse", () => response);
        }),
        requestHeaders,
        requestTimeout,
        onError,
        launch,
      }),
    };
    const reservedIds = new Set([...Object.keys(instance), "init"]);
    for (const plugin of plugins ?? []) {
      if (reservedIds.has(plugin.id)) {
        throw new Error(
          `[HotUpdater] A plugin cannot use the id "${plugin.id}": the HotUpdater instance has its own "${plugin.id}".`,
        );
      }
    }

    // Plugins are set up before the instance reads the launch they observe.
    const apis = host.configurePlugins(plugins, {
      baseURL,
      requestHeaders,
      requestTimeout,
      onError,
    });
    void launch.read({ onNotifyAppReady, onError });
    return Object.freeze({
      ...instance,
      ...apis,
    }) as HotUpdaterInstance<TPlugins>;
  },
};
