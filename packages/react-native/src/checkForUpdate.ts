import {
  authorizeReleaseTransition,
  createReleaseCatalogScopeKey,
  createReleaseSelectionContextHash,
  encodeChannelKey,
  selectDesiredRelease,
  type AppUpdateAvailableInfo,
  type AppUpdateInfo,
  type PersistedSelectionReceipt,
  type ReleaseCatalog,
} from "@hot-updater/core";
import { canonicalizeAppVersion } from "@hot-updater/plugin-core";
import { Platform } from "react-native";

import { HotUpdaterError, StaleReleaseCatalogError } from "./error";
import {
  acceptReleaseCatalog,
  commitReleaseSelection,
  getActiveUpdateState,
  getAppVersion,
  getBundleId,
  getChannel,
  getCohort,
  getDefaultChannel,
  getFingerprintHash,
  getInstallId,
  getMinBundleId,
  getCrashHistory,
  getPersistedUserIdentity,
  isReleaseSelectionCurrent,
  isChannelSwitched,
  resetChannel,
  updateBundle,
} from "./native";
import { hotUpdaterStore } from "./store";
import type { HotUpdaterResolver } from "./types";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

export interface CheckForUpdateOptions {
  /**
   * Update strategy
   * - "fingerprint": Use fingerprint hash to check for updates
   * - "appVersion": Use app version to check for updates
   * - Can override the strategy set in HotUpdater.wrap()
   */
  updateStrategy: "appVersion" | "fingerprint";

  /**
   * Override the current channel when checking for updates.
   * The channel switch is only persisted after the returned update is applied.
   */
  channel?: string;

  requestHeaders?: Record<string, string>;
  onError?: (error: Error) => void;
  /**
   * The timeout duration for the request.
   * @default 5000
   */
  requestTimeout?: number;
}

export type CheckForUpdateResult = AppUpdateAvailableInfo & {
  readonly releaseId?: string | null;
  readonly transitionKind?: ReleaseTransitionKind;
  /**
   * Updates the bundle.
   * This method is equivalent to `HotUpdater.updateBundle()` but with all required arguments pre-filled.
   */
  updateBundle: () => Promise<boolean>;
};

export type ReleaseTransitionKind =
  | "INSTALL"
  | "ADOPT_RELEASE"
  | "USE_EMBEDDED"
  | "USE_BUILTIN";

// Internal type that includes resolver for use within index.ts
export interface InternalCheckForUpdateOptions extends CheckForUpdateOptions {
  resolver: HotUpdaterResolver;
}

const isResetToBuiltInResponse = (updateInfo: AppUpdateInfo): boolean => {
  return (
    updateInfo.status === "ROLLBACK" &&
    updateInfo.id === NIL_UUID &&
    updateInfo.fileUrl === null
  );
};

const isV2Resolver = (
  resolver: HotUpdaterResolver,
): resolver is HotUpdaterResolver &
  Required<
    Pick<HotUpdaterResolver, "fetchReleaseCatalog" | "resolveArtifact">
  > =>
  typeof resolver.fetchReleaseCatalog === "function" &&
  typeof resolver.resolveArtifact === "function";

const sameReceipt = (
  first: PersistedSelectionReceipt | null,
  second: PersistedSelectionReceipt,
): boolean =>
  first !== null &&
  first.kind === second.kind &&
  first.releaseId === second.releaseId &&
  first.bundleId === second.bundleId &&
  first.authorityId === second.authorityId &&
  first.scopeKey === second.scopeKey &&
  first.generation === second.generation &&
  first.catalogHash === second.catalogHash &&
  first.channel === second.channel &&
  first.selectionContextHash === second.selectionContextHash;

const validateCatalog = (
  catalog: ReleaseCatalog,
  authorityId: string,
  scopeKey: string,
) => {
  if (
    catalog.schemaVersion !== 1 ||
    catalog.authorityId !== authorityId ||
    catalog.scopeKey !== scopeKey ||
    !Number.isSafeInteger(catalog.generation) ||
    catalog.generation < 1 ||
    !catalog.catalogHash.startsWith("sha256:")
  ) {
    throw new HotUpdaterError("Received an invalid Release catalog");
  }
};

const resetProgress = () => {
  hotUpdaterStore.setState({
    artifactType: null,
    details: null,
    downloadedBytes: undefined,
    isUpdateDownloaded: false,
    progress: 0,
    totalBytes: undefined,
  });
};

const notifyReleaseAdoption = async (input: {
  readonly active: PersistedSelectionReceipt | null;
  readonly desired: PersistedSelectionReceipt;
  readonly appVersion: string;
  readonly cohort: string;
  readonly fingerprintHash: string | null;
  readonly platform: "ios" | "android";
  readonly resolver: HotUpdaterResolver;
  readonly requestHeaders?: Record<string, string>;
  readonly requestTimeout?: number;
  readonly updateStrategy: "appVersion" | "fingerprint";
}): Promise<void> => {
  if (!input.resolver.notifyAppReady) return;
  const { userId, username } = getPersistedUserIdentity();
  try {
    await input.resolver.notifyAppReady({
      appVersion: input.appVersion,
      channel: input.desired.channel,
      cohort: input.cohort,
      fingerprintHash: input.fingerprintHash,
      fromBundleId: input.desired.bundleId,
      fromReleaseId: input.active?.releaseId ?? null,
      installId: getInstallId(),
      platform: input.platform,
      requestHeaders: input.requestHeaders,
      requestTimeout: input.requestTimeout,
      toBundleId: input.desired.bundleId,
      toReleaseId: input.desired.releaseId,
      type: "RELEASE_ADOPTED",
      updateStrategy: input.updateStrategy,
      ...(userId === undefined ? {} : { userId }),
      ...(username === undefined ? {} : { username }),
    });
  } catch (error) {
    console.warn("[HotUpdater] Release adoption analytics failed:", error);
  }
};

async function checkForReleaseCatalogUpdate(input: {
  readonly options: InternalCheckForUpdateOptions;
  readonly platform: "ios" | "android";
  readonly currentAppVersion: string;
  readonly currentBundleId: string;
  readonly minimumReleaseId: string;
  readonly defaultChannel: string;
  readonly currentChannel: string;
  readonly targetChannel: string;
  readonly explicitChannel: string | undefined;
  readonly isSwitched: boolean;
  readonly cohort: string;
  readonly fingerprintHash: string | null;
}): Promise<CheckForUpdateResult | null> {
  const { options } = input;
  const resolver = options.resolver as HotUpdaterResolver &
    Required<
      Pick<HotUpdaterResolver, "fetchReleaseCatalog" | "resolveArtifact">
    >;
  const authorityId = resolver.authorityId ?? "default";
  const channelKey = encodeChannelKey(input.targetChannel);
  const strategy =
    options.updateStrategy === "appVersion" ? "APP_VERSION" : "FINGERPRINT";
  const canonicalAppVersion = canonicalizeAppVersion(input.currentAppVersion);
  if (strategy === "APP_VERSION" && canonicalAppVersion === null) {
    throw new HotUpdaterError("Failed to canonicalize app version");
  }
  if (strategy === "FINGERPRINT" && !input.fingerprintHash) {
    throw new HotUpdaterError("Fingerprint hash is required");
  }
  const scopeKey = createReleaseCatalogScopeKey(
    strategy === "APP_VERSION"
      ? {
          authorityId,
          channelKey,
          platform: input.platform,
          strategy,
        }
      : {
          authorityId,
          channelKey,
          fingerprintHash: input.fingerprintHash!,
          platform: input.platform,
          strategy,
        },
  );
  const catalog = await resolver.fetchReleaseCatalog({
    appVersion: canonicalAppVersion ?? input.currentAppVersion,
    authorityId,
    channel: input.targetChannel,
    fingerprintHash: input.fingerprintHash,
    platform: input.platform,
    requestHeaders: options.requestHeaders,
    requestTimeout: options.requestTimeout,
    updateStrategy: options.updateStrategy,
  });
  validateCatalog(catalog, authorityId, scopeKey);

  const crashedBundleIds = getCrashHistory();
  const selectionContextHash = createReleaseSelectionContextHash({
    cohort: input.cohort,
    crashedBundleIds,
    minimumReleaseId: input.minimumReleaseId,
    strategy,
    strategyValue:
      strategy === "APP_VERSION"
        ? canonicalAppVersion!
        : input.fingerprintHash!,
  });
  if (
    !acceptReleaseCatalog({
      authorityId,
      catalogHash: catalog.catalogHash,
      channel: input.targetChannel,
      generation: catalog.generation,
      selectionContextHash,
      scopeKey,
    })
  ) {
    throw new HotUpdaterError(
      "Rejected a stale or inconsistent Release catalog",
    );
  }
  const desired = selectDesiredRelease(catalog, {
    builtInBundleId: input.minimumReleaseId,
    cohort: input.cohort,
    crashedBundleIds,
    minimumReleaseId: input.minimumReleaseId,
  });
  if (desired === null) return null;

  const receipt: PersistedSelectionReceipt = {
    authorityId,
    bundleId: desired.bundleId,
    catalogHash: catalog.catalogHash,
    channel: input.targetChannel,
    generation: catalog.generation,
    kind: desired.kind,
    releaseId: desired.releaseId,
    scopeKey,
    selectionContextHash,
  };
  const active = getActiveUpdateState().activeSelection;
  if (sameReceipt(active, receipt)) return null;

  const explicitScopeSwitch =
    input.explicitChannel !== undefined &&
    input.explicitChannel !== input.currentChannel;
  const authorization = authorizeReleaseTransition({
    active,
    desired: receipt,
    explicitScopeSwitch,
  });
  if (!authorization.authorized) {
    if (authorization.reason === "EMPTY_TARGET_SCOPE") return null;
    throw new HotUpdaterError(
      `Release transition rejected: ${authorization.reason}`,
    );
  }

  const release = desired.release;
  const transitionKind: ReleaseTransitionKind =
    desired.kind === "BUILTIN"
      ? "USE_BUILTIN"
      : desired.kind === "EMBEDDED"
        ? "USE_EMBEDDED"
        : active?.bundleId === desired.bundleId
          ? "ADOPT_RELEASE"
          : "INSTALL";
  const guard = {
    authorityId,
    catalogHash: catalog.catalogHash,
    channel: input.targetChannel,
    generation: catalog.generation,
    scopeKey,
    selectionContextHash,
  };
  const updateBundleForSelection = async (): Promise<boolean> => {
    resetProgress();
    if (!isReleaseSelectionCurrent(guard)) {
      throw new StaleReleaseCatalogError();
    }

    if (transitionKind !== "INSTALL") {
      const committed = await commitReleaseSelection({
        guard,
        selection: receipt,
      });
      if (committed && transitionKind === "ADOPT_RELEASE") {
        await notifyReleaseAdoption({
          active,
          appVersion: input.currentAppVersion,
          cohort: input.cohort,
          desired: receipt,
          fingerprintHash: input.fingerprintHash,
          platform: input.platform,
          requestHeaders: options.requestHeaders,
          requestTimeout: options.requestTimeout,
          resolver,
          updateStrategy: options.updateStrategy,
        });
      }
      return committed;
    }

    const artifact = await resolver.resolveArtifact({
      currentBundleId: input.currentBundleId,
      requestHeaders: options.requestHeaders,
      requestTimeout: options.requestTimeout,
      targetBundleId: desired.bundleId,
    });
    if (!isReleaseSelectionCurrent(guard)) {
      throw new StaleReleaseCatalogError();
    }
    return updateBundle({
      bundleId: desired.bundleId,
      changedAssets: artifact.changedAssets ?? null,
      channel: input.targetChannel,
      fileHash: artifact.fileHash,
      fileUrl: artifact.fileUrl,
      manifestFileHash: artifact.manifestFileHash ?? null,
      manifestUrl: artifact.manifestUrl ?? null,
      selection: receipt,
      shouldSkipCurrentBundleIdCheck: true,
      status: "UPDATE",
    });
  };

  return {
    fileHash: null,
    fileUrl: null,
    id: desired.bundleId,
    message: release?.message ?? null,
    releaseId: desired.releaseId,
    rolloutCohortCount: release?.rolloutCohortCount ?? 1000,
    shouldForceUpdate: release?.shouldForceUpdate ?? false,
    status: desired.kind === "BUNDLE" ? "UPDATE" : "ROLLBACK",
    targetCohorts: release?.targetCohorts ? [...release.targetCohorts] : [],
    transitionKind,
    updateBundle: updateBundleForSelection,
  };
}

export async function checkForUpdate(
  options: InternalCheckForUpdateOptions,
): Promise<CheckForUpdateResult | null> {
  if (__DEV__) {
    return null;
  }

  if (!["ios", "android"].includes(Platform.OS)) {
    options.onError?.(
      new HotUpdaterError("HotUpdater is only supported on iOS and Android"),
    );
    return null;
  }

  const currentAppVersion = getAppVersion();
  const platform = Platform.OS as "ios" | "android";
  const currentBundleId = getBundleId();
  const minBundleId = getMinBundleId();
  const defaultChannel = getDefaultChannel();
  const isSwitched = isChannelSwitched();
  const currentChannel = isSwitched ? getChannel() : defaultChannel;
  const explicitChannel = options.channel || undefined;
  const targetChannel = explicitChannel || currentChannel;
  const isFirstRuntimeChannelSwitchAttempt =
    !isSwitched &&
    explicitChannel !== undefined &&
    explicitChannel !== defaultChannel;
  const requestBundleId = isFirstRuntimeChannelSwitchAttempt
    ? minBundleId
    : currentBundleId;

  const cohort = getCohort();

  if (!currentAppVersion) {
    options.onError?.(new HotUpdaterError("Failed to get app version"));
    return null;
  }

  if (isSwitched && explicitChannel && explicitChannel !== currentChannel) {
    const error = new HotUpdaterError(
      `Runtime channel is already switched to "${currentChannel}". Call HotUpdater.resetChannel() before checking "${explicitChannel}".`,
    );
    options.onError?.(error);
    throw error;
  }

  const fingerprintHash = getFingerprintHash();

  if (isV2Resolver(options.resolver)) {
    try {
      return await checkForReleaseCatalogUpdate({
        cohort,
        currentAppVersion,
        currentBundleId,
        currentChannel,
        defaultChannel,
        explicitChannel,
        fingerprintHash,
        isSwitched,
        minimumReleaseId: minBundleId,
        options,
        platform,
        targetChannel,
      });
    } catch (error) {
      options.onError?.(error as Error);
      return null;
    }
  }

  if (!options.resolver?.checkUpdate) {
    options.onError?.(
      new HotUpdaterError("Resolver is required but not configured"),
    );
    return null;
  }

  let updateInfo: AppUpdateInfo | null = null;

  try {
    updateInfo = await options.resolver.checkUpdate({
      platform,
      appVersion: currentAppVersion,
      bundleId: requestBundleId,
      minBundleId,
      cohort,
      channel: targetChannel,
      updateStrategy: options.updateStrategy,
      fingerprintHash,
      requestHeaders: options.requestHeaders,
      requestTimeout: options.requestTimeout,
    });
  } catch (error) {
    options.onError?.(error as Error);
    return null;
  }

  if (!updateInfo) {
    return null;
  }

  if (updateInfo.status === "UP_TO_DATE") {
    return null;
  }

  if (
    explicitChannel &&
    explicitChannel !== defaultChannel &&
    !isSwitched &&
    updateInfo.status === "ROLLBACK"
  ) {
    return null;
  }

  return {
    ...updateInfo,
    updateBundle: async () => {
      if (
        explicitChannel &&
        isSwitched &&
        isResetToBuiltInResponse(updateInfo)
      ) {
        return resetChannel();
      }

      const runtimeChannel =
        updateInfo.fileUrl !== null ? targetChannel : undefined;

      resetProgress();

      return updateBundle({
        bundleId: updateInfo.id,
        channel: runtimeChannel,
        changedAssets: updateInfo.changedAssets ?? null,
        fileUrl: updateInfo.fileUrl,
        fileHash: updateInfo.fileHash,
        manifestFileHash: updateInfo.manifestFileHash ?? null,
        manifestUrl: updateInfo.manifestUrl ?? null,
        status: updateInfo.status,
        shouldSkipCurrentBundleIdCheck: isFirstRuntimeChannelSwitchAttempt,
      });
    },
  };
}
