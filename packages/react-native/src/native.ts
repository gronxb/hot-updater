import {
  type ChangedAsset,
  INVALID_COHORT_ERROR_MESSAGE,
  isValidCohort,
  normalizeCohortValue,
  type UpdateStatus,
} from "@hot-updater/core";
import { NativeEventEmitter, Platform } from "react-native";

import { HotUpdaterErrorCode, isHotUpdaterError } from "./error";
import HotUpdaterNative, {
  type UpdateBundleParams,
} from "./specs/NativeHotUpdater";

export { HotUpdaterErrorCode, isHotUpdaterError };

const NIL_UUID = "00000000-0000-0000-0000-000000000000";
const normalizeAndValidateCohort = (cohort: string): string => {
  const normalized = normalizeCohortValue(cohort);
  if (!isValidCohort(normalized)) {
    throw new Error(INVALID_COHORT_ERROR_MESSAGE);
  }
  return normalized;
};

export interface ManifestAsset {
  fileHash: string;
  signature?: string;
}

export interface Manifest {
  bundleId: string;
  assets: Record<string, ManifestAsset>;
}

type ActiveBundleSnapshotCacheValues = {
  bundleId?: string;
  manifest?: Manifest;
  baseURL?: string | null;
};

type ActiveBundleSnapshotCacheKey = keyof ActiveBundleSnapshotCacheValues;

/**
 * Built-in reload behaviors used by `HotUpdater.reload()`.
 *
 * - `reload`: In-process React Native reload.
 * - `processRestart`: Android-only cold restart. On iOS the same call behaves like `reload`.
 */
export type ReloadBehavior = "reload" | "processRestart";

/**
 * Custom reload hook used when `setReloadBehavior("custom", handler)` is configured.
 *
 * This is useful for brownfield apps that need to delegate reload behavior to
 * a host-native container instead of using HotUpdater's built-in reload flow.
 */
export type CustomReloadHandler = () => void | Promise<void>;

/**
 * Full reload policy accepted by `setReloadBehavior()`.
 *
 * - `reload`: Built-in React reload on both platforms
 * - `processRestart`: Android process restart, iOS behaves like `reload`
 * - `custom`: Run a user-provided JS handler on both platforms
 */
export type ReloadBehaviorSetting = ReloadBehavior | "custom";

class HotUpdaterSessionState {
  private readonly defaultChannel: string;
  private currentChannel: string;
  private cachedCohort: string | undefined;
  private readonly inflightUpdates = new Map<string, Promise<boolean>>();
  private lastInstalledBundleId: string | null = null;
  private readonly activeBundleSnapshotCache = new Map<
    ActiveBundleSnapshotCacheKey,
    ActiveBundleSnapshotCacheValues[ActiveBundleSnapshotCacheKey]
  >();

  constructor() {
    const constants = HotUpdaterNative.getConstants();
    this.defaultChannel = constants.DEFAULT_CHANNEL ?? constants.CHANNEL;
    this.currentChannel = constants.CHANNEL;
  }

  getChannel(): string {
    return this.currentChannel;
  }

  getDefaultChannel(): string {
    return this.defaultChannel;
  }

  isChannelSwitched(): boolean {
    return this.currentChannel !== this.defaultChannel;
  }

  hasInstalledBundle(bundleId: string): boolean {
    return this.lastInstalledBundleId === bundleId;
  }

  getInflightUpdate(bundleId: string): Promise<boolean> | undefined {
    return this.inflightUpdates.get(bundleId);
  }

  trackInflightUpdate(bundleId: string, promise: Promise<boolean>) {
    this.inflightUpdates.set(bundleId, promise);
  }

  clearInflightUpdate(bundleId: string) {
    this.inflightUpdates.delete(bundleId);
  }

  markBundleInstalled(bundleId: string, channel?: string) {
    this.lastInstalledBundleId = bundleId;
    if (channel) {
      this.currentChannel = channel;
    }
    this.clearActiveBundleSnapshotCache();
  }

  resetChannelState() {
    this.currentChannel = this.defaultChannel;
    this.lastInstalledBundleId = null;
    this.inflightUpdates.clear();
    this.clearActiveBundleSnapshotCache();
  }

  getCachedBundleId(): string | undefined {
    return this.getActiveBundleSnapshotValue("bundleId");
  }

  cacheBundleId(bundleId: string) {
    this.setActiveBundleSnapshotValue("bundleId", bundleId);
  }

  getCachedManifest(): Manifest | undefined {
    const manifest = this.getActiveBundleSnapshotValue("manifest");
    return manifest ? cloneManifest(manifest) : undefined;
  }

  cacheManifest(manifest: Manifest) {
    this.setActiveBundleSnapshotValue("manifest", cloneManifest(manifest));
  }

  getCachedBaseURL(): string | null | undefined {
    return this.getActiveBundleSnapshotValue("baseURL");
  }

  cacheBaseURL(baseURL: string | null) {
    this.setActiveBundleSnapshotValue("baseURL", baseURL);
  }

  getCachedCohort(): string | undefined {
    return this.cachedCohort;
  }

  cacheCohort(cohort: string) {
    this.cachedCohort = cohort;
  }

  private clearActiveBundleSnapshotCache() {
    this.activeBundleSnapshotCache.clear();
  }

  private getActiveBundleSnapshotValue<K extends ActiveBundleSnapshotCacheKey>(
    key: K,
  ): ActiveBundleSnapshotCacheValues[K] | undefined {
    return this.activeBundleSnapshotCache.get(key) as
      | ActiveBundleSnapshotCacheValues[K]
      | undefined;
  }

  private setActiveBundleSnapshotValue<K extends ActiveBundleSnapshotCacheKey>(
    key: K,
    value: ActiveBundleSnapshotCacheValues[K],
  ) {
    this.activeBundleSnapshotCache.set(key, value);
  }
}

const sessionState = new HotUpdaterSessionState();
let reloadBehavior: ReloadBehaviorSetting = "processRestart";
let customReloadHandler: CustomReloadHandler | null = null;

const cloneManifest = (manifest: Manifest): Manifest => ({
  bundleId: manifest.bundleId,
  assets: Object.fromEntries(
    Object.entries(manifest.assets).map(([key, asset]) => [
      key,
      {
        fileHash: asset.fileHash,
        ...(asset.signature ? { signature: asset.signature } : {}),
      },
    ]),
  ),
});

const getNativeBundleId = (): string | null => {
  const nativeModule = HotUpdaterNative as typeof HotUpdaterNative & {
    getBundleId?: () => string | null;
  };

  if (typeof nativeModule.getBundleId !== "function") {
    throw new Error(
      "[HotUpdater] Native module is missing 'getBundleId()'. This JS bundle requires a newer native @hot-updater/react-native SDK. Rebuild and release a new app version before delivering this OTA update.",
    );
  }

  return nativeModule.getBundleId();
};

const resolveBundleId = (bundleId: string | null): string => {
  return !bundleId || bundleId === NIL_UUID ? getMinBundleId() : bundleId;
};

const getFreshBundleId = (): string => {
  const resolvedBundleId = resolveBundleId(getNativeBundleId());
  sessionState.cacheBundleId(resolvedBundleId);
  return resolvedBundleId;
};

const getReloadProcess = (): (() => Promise<void>) | null => {
  const nativeModule = HotUpdaterNative as typeof HotUpdaterNative & {
    reloadProcess?: () => Promise<void>;
  };

  return typeof nativeModule.reloadProcess === "function"
    ? nativeModule.reloadProcess.bind(nativeModule)
    : null;
};

export type HotUpdaterProgressArtifactType = "archive" | "diff";

export type HotUpdaterDiffFileStatus =
  | "pending"
  | "downloading"
  | "downloaded"
  | "failed";

export interface HotUpdaterDiffFileSnapshot {
  /**
   * Manifest asset path for this progress entry.
   *
   * This is the stable identity of the asset in the installed bundle. Use this
   * when matching progress back to the manifest or to the final file location.
   */
  path: string;
  /**
   * Artifact path currently being transferred for this progress entry.
   *
   * Usually this is the same as `path`. It can differ when the updater
   * downloads an intermediate artifact that will be applied to produce the
   * final asset.
   */
  downloadPath: string;
  /**
   * Current download state for this asset within the manifest diff update.
   */
  status: HotUpdaterDiffFileStatus;
  /**
   * Download progress for this file, normalized from 0 to 1.
   */
  progress: number;
  /**
   * Stable display order among diff files.
   */
  order: number;
  /**
   * Bytes downloaded for `downloadPath`, when the native downloader reports it.
   */
  downloadedBytes?: number;
  /**
   * Total expected bytes for `downloadPath`, when known.
   */
  totalBytes?: number;
}

export interface HotUpdaterDiffProgressDetails {
  totalFilesCount: number;
  completedFilesCount: number;
  files: HotUpdaterDiffFileSnapshot[];
}

export type HotUpdaterProgressEvent =
  | {
      progress: number;
      artifactType: "archive";
      downloadedBytes?: number;
      totalBytes?: number;
    }
  | {
      progress: number;
      artifactType: "diff";
      details: HotUpdaterDiffProgressDetails;
    };

export type HotUpdaterEvent = {
  onProgress: HotUpdaterProgressEvent;
};

const eventEmitter = new NativeEventEmitter(HotUpdaterNative);

export const addListener = <T extends keyof HotUpdaterEvent>(
  eventName: T,
  listener: (event: HotUpdaterEvent[T]) => void,
) => {
  const subscription = eventEmitter.addListener(eventName, listener);

  return () => {
    subscription.remove();
  };
};

export type UpdateParams = UpdateBundleParams & {
  status: UpdateStatus;
  shouldSkipCurrentBundleIdCheck?: boolean;
};

/**
 * Downloads files and applies them to the app.
 *
 * @param {UpdateParams} params - Parameters object required for bundle update
 * @returns {Promise<boolean>} Resolves with true if download was successful
 * @throws {Error} Rejects with error.code from HotUpdaterErrorCode enum and error.message
 */
export async function updateBundle(params: UpdateParams): Promise<boolean>;
/**
 * @deprecated Use updateBundle(params: UpdateBundleParamsWithStatus) instead
 */
export async function updateBundle(
  bundleId: string,
  fileUrl: string | null,
): Promise<boolean>;
export async function updateBundle(
  paramsOrBundleId: UpdateParams | string,
  fileUrl?: string | null,
): Promise<boolean> {
  const updateBundleId =
    typeof paramsOrBundleId === "string"
      ? paramsOrBundleId
      : paramsOrBundleId.bundleId;

  const status =
    typeof paramsOrBundleId === "string" ? "UPDATE" : paramsOrBundleId.status;

  const targetFileUrl =
    typeof paramsOrBundleId === "string"
      ? (fileUrl ?? null)
      : paramsOrBundleId.fileUrl;

  const currentBundleId = status === "UPDATE" ? getFreshBundleId() : undefined;

  // If native is still on the same bundle we installed in this session,
  // skip re-download. Native state can move back to the built-in bundle after
  // rollback/reset, so check a fresh native bundle id before using this guard.
  if (
    status === "UPDATE" &&
    sessionState.hasInstalledBundle(updateBundleId) &&
    currentBundleId === updateBundleId
  ) {
    return true;
  }

  const shouldSkipCurrentBundleIdCheck =
    typeof paramsOrBundleId === "string"
      ? false
      : paramsOrBundleId.shouldSkipCurrentBundleIdCheck === true;

  if (
    !shouldSkipCurrentBundleIdCheck &&
    status === "UPDATE" &&
    currentBundleId !== undefined &&
    updateBundleId.localeCompare(currentBundleId) <= 0
  ) {
    throw new Error(
      "Update bundle id is not newer than the current bundle id. Preventing infinite update loop.",
    );
  }

  // In-flight guard: return the same promise if the same bundle is already updating.
  const existing = sessionState.getInflightUpdate(updateBundleId);
  if (existing) return existing;

  const targetFileHash =
    typeof paramsOrBundleId === "string"
      ? undefined
      : paramsOrBundleId.fileHash;

  const targetChannel =
    typeof paramsOrBundleId === "string" ? undefined : paramsOrBundleId.channel;
  const targetManifestUrl =
    typeof paramsOrBundleId === "string"
      ? undefined
      : paramsOrBundleId.manifestUrl;
  const targetManifestFileHash =
    typeof paramsOrBundleId === "string"
      ? undefined
      : paramsOrBundleId.manifestFileHash;
  const targetChangedAssets =
    typeof paramsOrBundleId === "string"
      ? undefined
      : paramsOrBundleId.changedAssets;

  const promise = (async () => {
    try {
      const ok = await HotUpdaterNative.updateBundle({
        bundleId: updateBundleId,
        channel: targetChannel,
        changedAssets:
          (targetChangedAssets as Record<string, ChangedAsset> | null) ?? null,
        fileUrl: targetFileUrl,
        fileHash: targetFileHash ?? null,
        manifestFileHash: targetManifestFileHash ?? null,
        manifestUrl: targetManifestUrl ?? null,
      });
      if (ok) {
        sessionState.markBundleInstalled(updateBundleId, targetChannel);
      }
      return ok;
    } finally {
      sessionState.clearInflightUpdate(updateBundleId);
    }
  })();

  sessionState.trackInflightUpdate(updateBundleId, promise);
  return promise;
}

/**
 * Fetches the current app version.
 */
export const getAppVersion = (): string | null => {
  const constants = HotUpdaterNative.getConstants();
  return constants?.APP_VERSION ?? null;
};

/**
 * Reloads the app using the currently configured reload behavior.
 *
 * Default behavior is `processRestart`.
 * On iOS, `processRestart` behaves like the normal React reload path.
 *
 * When `setReloadBehavior("processRestart")` is used:
 * - Android performs a cold process restart
 * - iOS keeps the same behavior as the normal React reload path
 * - older Android native binaries fall back to `reload()` if `reloadProcess()` is unavailable
 *
 * When `setReloadBehavior("custom", handler)` is used:
 * - both Android and iOS execute the provided handler
 */
export const reload = async () => {
  if (reloadBehavior === "custom") {
    if (!customReloadHandler) {
      throw new Error(
        "[HotUpdater] setReloadBehavior('custom') requires a reload handler.",
      );
    }

    await customReloadHandler();
    return;
  }

  if (Platform.OS === "android" && reloadBehavior === "processRestart") {
    const reloadProcess = getReloadProcess();
    if (reloadProcess) {
      await reloadProcess();
      return;
    }
  }

  await HotUpdaterNative.reload();
};

/**
 * Configures how `HotUpdater.reload()` should behave.
 *
 * This API is available on both Android and iOS so app code can stay symmetric.
 * By default, HotUpdater uses `processRestart`.
 *
 * Supported behaviors:
 * - `reload`: Uses React Native's normal in-process reload flow
 * - `processRestart`: Uses Android process restart when available; iOS keeps the same behavior as `reload`
 * - `custom`: Executes a JS callback on both platforms
 *
 * `custom` is intended for brownfield apps that need host-native coordination.
 */
export function setReloadBehavior(
  ...args:
    | [behavior: ReloadBehavior]
    | [behavior: "custom", handler: CustomReloadHandler]
): void {
  const [behavior, handler] = args;

  if (behavior === "custom") {
    if (typeof handler !== "function") {
      throw new Error(
        "[HotUpdater] setReloadBehavior('custom') requires a reload handler.",
      );
    }

    reloadBehavior = behavior;
    customReloadHandler = handler;
    return;
  }

  if (handler) {
    throw new Error(
      `[HotUpdater] setReloadBehavior('${behavior}') does not accept a custom reload handler.`,
    );
  }

  reloadBehavior = behavior;
  customReloadHandler = null;
}

/**
 * Fetches the minimum bundle id, which represents the initial bundle of the app
 * since it is created at build time.
 *
 * @returns {string} Resolves with the minimum bundle id or null if not available.
 */
export const getMinBundleId = (): string => {
  const constants = HotUpdaterNative.getConstants();
  return constants.MIN_BUNDLE_ID;
};

/**
 * Fetches the current bundle version id.
 *
 * JS falls back to MIN_BUNDLE_ID only after native confirms there is no active
 * downloaded bundle. When the native module does not expose `getBundleId()`,
 * treat it as a JS/native SDK mismatch instead of silently reporting the
 * built-in bundle.
 *
 * @returns {string} Resolves with the current version id.
 */
export const getBundleId = (): string => {
  const cachedBundleId = sessionState.getCachedBundleId();
  if (cachedBundleId !== undefined) {
    return cachedBundleId;
  }

  return getFreshBundleId();
};

/**
 * Fetches the current manifest for the active bundle.
 *
 * Returns a normalized manifest with empty assets when manifest.json is missing
 * or invalid.
 */
export const getManifest = (): Manifest => {
  const cachedManifest = sessionState.getCachedManifest();
  if (cachedManifest !== undefined) {
    return cachedManifest;
  }

  const nativeModule = HotUpdaterNative as typeof HotUpdaterNative & {
    getManifest?: () => Record<string, unknown> | string;
  };
  const manifest = nativeModule.getManifest?.();

  let normalizedManifest: Manifest;

  if (!manifest) {
    normalizedManifest = createEmptyManifest();
  } else if (typeof manifest === "string") {
    try {
      normalizedManifest = normalizeManifest(JSON.parse(manifest));
    } catch {
      normalizedManifest = createEmptyManifest();
    }
  } else {
    normalizedManifest = normalizeManifest(manifest);
  }

  sessionState.cacheBundleId(normalizedManifest.bundleId);
  sessionState.cacheManifest(normalizedManifest);
  return cloneManifest(normalizedManifest);
};

/**
 * Fetches the channel for the app.
 *
 * @returns {string} Resolves with the channel or null if not available.
 */
export const getChannel = (): string => {
  return sessionState.getChannel();
};

/**
 * Fetches the build-time default channel for the app.
 */
export const getDefaultChannel = (): string => {
  return sessionState.getDefaultChannel();
};

/**
 * Returns whether the app is currently using a runtime channel override.
 */
export const isChannelSwitched = (): boolean => {
  return sessionState.isChannelSwitched();
};

/**
 * Fetches the fingerprint for the app.
 *
 * @returns {string | null} Resolves with the fingerprint hash
 */
export const getFingerprintHash = (): string | null => {
  const constants = HotUpdaterNative.getConstants();
  return constants.FINGERPRINT_HASH;
};

/**
 * Result returned by notifyAppReady()
 */
export type NotifyAppReadyResult = {
  status: "RECOVERED" | "STABLE";
  crashedBundleId?: string;
};

/**
 * Reads the native launch report for the current process.
 *
 * This function is called automatically after the app has rendered.
 *
 * @returns {NotifyAppReadyResult} Bundle state information
 * - `status: "RECOVERED"` - App recovered from crash, rollback occurred (ROLLBACK event)
 * - `status: "STABLE"` - No changes, already stable
 * - `crashedBundleId` - Present only when status is "RECOVERED"
 *
 * @example
 * ```ts
 * const result = HotUpdater.notifyAppReady();
 *
 * if (result.status === "RECOVERED") {
 *   // Send ROLLBACK analytics event
 *   analytics.track("bundle_rollback", {
 *     crashedBundleId: result.crashedBundleId,
 *   });
 * }
 * ```
 */
export const notifyAppReady = (): NotifyAppReadyResult => {
  const result = HotUpdaterNative.notifyAppReady();
  // Older Android old-arch implementations returned JSON strings.
  if (typeof result === "string") {
    try {
      return normalizeNotifyAppReadyResult(JSON.parse(result));
    } catch {
      return { status: "STABLE" };
    }
  }
  return normalizeNotifyAppReadyResult(result);
};

const normalizeNotifyAppReadyResult = (
  result: NotifyAppReadyResult | { status?: string; crashedBundleId?: string },
): NotifyAppReadyResult => {
  if (result.status === "RECOVERED") {
    return {
      status: "RECOVERED",
      crashedBundleId: result.crashedBundleId,
    };
  }

  return { status: "STABLE" };
};

const createEmptyManifest = (): Manifest => ({
  bundleId: getBundleId(),
  assets: {},
});

const normalizeManifest = (value: unknown): Manifest => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return createEmptyManifest();
  }

  const bundleIdValue = (value as { bundleId?: unknown }).bundleId;
  const bundleId =
    typeof bundleIdValue === "string" && bundleIdValue.trim()
      ? bundleIdValue.trim()
      : getBundleId();

  return {
    bundleId,
    assets: normalizeManifestAssets((value as { assets?: unknown }).assets),
  };
};

const normalizeManifestAssets = (value: unknown): Manifest["assets"] => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).flatMap(([key, entry]) => {
      const trimmedKey = key.trim();

      if (!trimmedKey) {
        return [];
      }

      if (typeof entry === "string") {
        const fileHash = entry.trim();

        if (!fileHash) {
          return [];
        }

        return [[trimmedKey, { fileHash }] as const];
      }

      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return [];
      }

      const { fileHash, signature } = entry as {
        fileHash?: unknown;
        signature?: unknown;
      };
      if (typeof fileHash !== "string" || !fileHash.trim()) {
        return [];
      }

      return [
        [
          trimmedKey,
          {
            fileHash: fileHash.trim(),
            ...(typeof signature === "string" && signature.trim()
              ? { signature: signature.trim() }
              : {}),
          },
        ] as const,
      ];
    }),
  );
};

/**
 * Gets the list of bundle IDs that have been marked as crashed.
 * These bundles will be rejected if attempted to install again.
 *
 * @returns {string[]} Array of crashed bundle IDs
 */
export const getCrashHistory = (): string[] => {
  const result = HotUpdaterNative.getCrashHistory();
  // Older Android old-arch implementations returned JSON strings.
  if (typeof result === "string") {
    try {
      return JSON.parse(result);
    } catch {
      return [];
    }
  }
  return result;
};

/**
 * Clears the crashed bundle history, allowing previously crashed bundles
 * to be installed again.
 *
 * @returns {boolean} true if clearing was successful
 */
export const clearCrashHistory = (): boolean => {
  return HotUpdaterNative.clearCrashHistory();
};

/**
 * Gets the base URL for the current active bundle directory.
 * Returns the file:// URL to the bundle directory without trailing slash.
 * This is used for Expo DOM components to construct full asset paths.
 *
 * @returns {string | null} Base URL string (e.g., "file:///data/.../bundle-store/abc123") or null if not available
 */
export const getBaseURL = (): string | null => {
  const cachedBaseURL = sessionState.getCachedBaseURL();
  if (cachedBaseURL !== undefined) {
    return cachedBaseURL;
  }

  const result = HotUpdaterNative.getBaseURL();
  const baseURL = typeof result === "string" && result !== "" ? result : null;
  sessionState.cacheBaseURL(baseURL);
  return baseURL;
};

/**
 * Clears the runtime channel override and restores the original bundle.
 */
export const resetChannel = async (): Promise<boolean> => {
  const ok = await HotUpdaterNative.resetChannel();
  if (ok) {
    sessionState.resetChannelState();
  }
  return ok;
};

/**
 * Sets the persisted cohort used for update checks.
 *
 * HotUpdater only derives a device-based cohort when nothing has been stored
 * yet. If you need to restore that initial value later, read it with
 * `getCohort()` before calling `setCohort()`, then store it yourself.
 */
export const setCohort = (cohort: string): void => {
  const normalized = normalizeAndValidateCohort(cohort);
  HotUpdaterNative.setCohort(normalized);
  sessionState.cacheCohort(normalized);
};

/**
 * Gets the persisted cohort used for rollout calculations.
 * If none has been stored yet, native derives the initial value once and
 * persists it before returning.
 */
export const getCohort = (): string => {
  const cachedCohort = sessionState.getCachedCohort();
  if (cachedCohort !== undefined) {
    return cachedCohort;
  }

  const cohort = normalizeAndValidateCohort(HotUpdaterNative.getCohort());
  sessionState.cacheCohort(cohort);
  return cohort;
};
