import {
  authorizeReleaseTransition,
  createReleaseSelectionContextHash,
  encodeChannelKey,
  selectDesiredRelease,
  type ArtifactInfo,
  type PersistedSelectionReceipt,
  type ReleaseCatalog,
} from "@hot-updater/core";
import { canonicalizeAppVersion } from "@hot-updater/plugin-core";
import { Platform } from "react-native";

import { HotUpdaterError, StaleReleaseCatalogError } from "./error";
import type { HotUpdaterHttpClient, HotUpdaterHttpSession } from "./httpClient";
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
  getMinimumReleaseId,
  getCrashHistory,
  getPersistedUserIdentity,
  isReleaseSelectionCurrent,
  isChannelSwitched,
  updateBundle,
} from "./native";
import {
  hasExpectedReleaseCatalogScope,
  type ExpectedReleaseCatalogScope,
} from "./releaseCatalogCache";
import { hotUpdaterStore } from "./store";

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

export type CheckForUpdateResult = ArtifactInfo & {
  readonly id: string;
  readonly message: string | null;
  readonly rolloutCohortCount: number;
  readonly shouldForceUpdate: boolean;
  readonly status: "ROLLBACK" | "UPDATE";
  readonly targetCohorts: string[];
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

export interface InternalCheckForUpdateOptions extends CheckForUpdateOptions {
  analytics?: boolean;
  client: HotUpdaterHttpClient;
}

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
  expectedScope: ExpectedReleaseCatalogScope,
) => {
  if (
    catalog.schemaVersion !== 1 ||
    !Number.isSafeInteger(catalog.generation) ||
    catalog.generation < 1 ||
    !/^sha256:[0-9a-f]{64}$/.test(catalog.catalogHash) ||
    !hasExpectedReleaseCatalogScope(catalog, expectedScope)
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
  readonly session: HotUpdaterHttpSession;
  readonly requestHeaders?: Record<string, string>;
  readonly requestTimeout?: number;
  readonly updateStrategy: "appVersion" | "fingerprint";
}): Promise<void> => {
  const { userId, username } = getPersistedUserIdentity();
  try {
    await input.session.sendAnalyticsEvent({
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
  const session = await options.client.createSession();
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
  const expectedScope: ExpectedReleaseCatalogScope =
    strategy === "APP_VERSION"
      ? {
          channelKey,
          platform: input.platform,
          strategy,
        }
      : {
          channelKey,
          fingerprintHash: input.fingerprintHash!,
          platform: input.platform,
          strategy,
        };
  const catalog = await session.fetchReleaseCatalog({
    appVersion: canonicalAppVersion ?? input.currentAppVersion,
    channel: input.targetChannel,
    fingerprintHash: input.fingerprintHash,
    platform: input.platform,
    requestHeaders: options.requestHeaders,
    requestTimeout: options.requestTimeout,
    updateStrategy: options.updateStrategy,
  });
  validateCatalog(catalog, expectedScope);
  const authorityId = catalog.authorityId;
  const scopeKey = catalog.scopeKey;

  const crashedBundleIds = getCrashHistory();
  const active = getActiveUpdateState().activeSelection;
  const explicitScopeSwitch =
    input.explicitChannel !== undefined &&
    input.explicitChannel !== input.currentChannel;
  const activeInTargetScope =
    active?.authorityId === authorityId && active.scopeKey === scopeKey
      ? active
      : null;
  const hasAuthenticatedActive =
    active !== null &&
    active.authorityId !== null &&
    active.scopeKey !== null &&
    active.generation !== null;
  if (
    hasAuthenticatedActive &&
    activeInTargetScope === null &&
    !explicitScopeSwitch
  ) {
    throw new HotUpdaterError("Release transition rejected: UNSOLICITED_SCOPE");
  }
  const selectorCurrentBundleId =
    activeInTargetScope !== null ||
    (!hasAuthenticatedActive && !explicitScopeSwitch)
      ? input.currentBundleId
      : input.minimumReleaseId;
  const selectionContextHash = createReleaseSelectionContextHash({
    activeBundleId: selectorCurrentBundleId,
    activeReleaseId: activeInTargetScope?.releaseId ?? null,
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
    activeReleaseId: activeInTargetScope?.releaseId ?? null,
    builtInBundleId: input.minimumReleaseId,
    cohort: input.cohort,
    crashedBundleIds,
    currentBundleId: selectorCurrentBundleId,
    minimumReleaseId: input.minimumReleaseId,
  });
  if (desired === null) return null;

  if (
    desired.kind === "BUILTIN" &&
    input.currentBundleId === input.minimumReleaseId &&
    (active === null || active.kind === "BUILTIN")
  ) {
    return null;
  }

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
  if (sameReceipt(active, receipt)) return null;

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
      if (
        committed &&
        transitionKind === "ADOPT_RELEASE" &&
        options.analytics
      ) {
        await notifyReleaseAdoption({
          active,
          appVersion: input.currentAppVersion,
          cohort: input.cohort,
          desired: receipt,
          fingerprintHash: input.fingerprintHash,
          platform: input.platform,
          requestHeaders: options.requestHeaders,
          requestTimeout: options.requestTimeout,
          session,
          updateStrategy: options.updateStrategy,
        });
      }
      return committed;
    }

    const artifact = await session.resolveArtifact({
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
      status: desired.status,
    });
  };

  return {
    fileHash: null,
    fileUrl: null,
    id: desired.bundleId,
    message: release?.message ?? null,
    releaseId: desired.releaseId,
    rolloutCohortCount: release?.rolloutCohortCount ?? 1000,
    shouldForceUpdate:
      transitionKind === "ADOPT_RELEASE"
        ? false
        : desired.status === "ROLLBACK"
          ? true
          : (release?.shouldForceUpdate ?? false),
    status: desired.status,
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
  const minimumReleaseId = getMinimumReleaseId();
  const defaultChannel = getDefaultChannel();
  const isSwitched = isChannelSwitched();
  const currentChannel = isSwitched ? getChannel() : defaultChannel;
  const explicitChannel = options.channel || undefined;
  const targetChannel = explicitChannel || currentChannel;
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
      minimumReleaseId,
      options,
      platform,
      targetChannel,
    });
  } catch (error) {
    options.onError?.(error as Error);
    return null;
  }
}
