import {
  authorizeReleaseTransition,
  canonicalizeAppVersion,
  createReleaseSelectionContextHash,
  encodeChannelKey,
  type ExpectedReleaseCatalogScope,
  hasExpectedReleaseCatalogScope,
  selectDesiredRelease,
  type PersistedSelectionReceipt,
  type ReleaseCatalog,
} from "@hot-updater/protocol";
import { Platform } from "react-native";

import { emitAfterAppReady, getRunningReleaseId } from "./appReady";
import type {
  ReleaseTransitionKind,
  UpdateErrorResource,
  UpdateErrorStage,
} from "./clientPlugin";
import { HotUpdaterError, StaleReleaseCatalogError } from "./error";
import type { HotUpdaterHttpClient } from "./httpClient";
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
  getMinBundleId,
  getCrashHistory,
  isReleaseSelectionCurrent,
  isChannelSwitched,
  stageBundle,
} from "./native";
import { hotUpdaterStore } from "./store";
import { classifyUpdateError, InvalidUpdateResponseError } from "./updateError";

export type { ReleaseTransitionKind };

export interface CheckForUpdateOptions {
  /**
   * Update strategy
   * - "fingerprint": Use fingerprint hash to check for updates
   * - "appVersion": Use app version to check for updates
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

export type CheckForUpdateResult = {
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

export interface InternalCheckForUpdateOptions extends CheckForUpdateOptions {
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
  first.catalogId === second.catalogId &&
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
    throw new InvalidUpdateResponseError("Received an invalid Release catalog");
  }
};

const resetProgress = () => {
  hotUpdaterStore.setState({
    artifactType: null,
    details: null,
    isUpdateDownloaded: false,
    progress: 0,
  });
};

/** The running bundle, the channel checked, and the update's target. */
type UpdateErrorScope = {
  readonly channel: string;
  readonly bundleId: string;
  readonly updateStrategy: "fingerprint" | "appVersion";
  readonly targetBundleId?: string;
  readonly targetReleaseId?: string | null;
};

/**
 * Tells plugins why an update failed, when it failed as an update. An error
 * the SDK's JavaScript raised happened in `stage`, fetching `resource`.
 */
export const reportUpdateError = (
  error: unknown,
  stage: UpdateErrorStage,
  resource: UpdateErrorResource | undefined,
  scope: UpdateErrorScope,
): void => {
  emitAfterAppReady("onUpdateError", () => {
    const classification = classifyUpdateError(error, stage, resource);
    if (classification === null) return null;
    return {
      ...classification,
      channel: scope.channel,
      bundleId: scope.bundleId,
      releaseId: getRunningReleaseId(scope.bundleId, getChannel()),
      updateStrategy: scope.updateStrategy,
      ...(scope.targetBundleId === undefined
        ? {}
        : { targetBundleId: scope.targetBundleId }),
      ...(scope.targetReleaseId == null
        ? {}
        : { targetReleaseId: scope.targetReleaseId }),
      cause: error,
    };
  });
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
  // The server says this scope has no catalog yet: no update, not a failure.
  if (catalog === null) return null;
  validateCatalog(catalog, expectedScope);
  const catalogId = catalog.catalogId;
  const scopeKey = catalog.scopeKey;

  const crashedBundleIds = getCrashHistory();
  const activeState = getActiveUpdateState();
  const active = activeState.activeSelection;
  const explicitScopeSwitch =
    input.explicitChannel !== undefined &&
    input.explicitChannel !== input.currentChannel;
  const activeInTargetScope =
    active?.catalogId === catalogId && active.scopeKey === scopeKey
      ? active
      : null;
  const hasAuthenticatedActive =
    active !== null &&
    active.catalogId !== null &&
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
      catalogId,
      catalogHash: catalog.catalogHash,
      channel: input.targetChannel,
      generation: catalog.generation,
      selectionContextHash,
      scopeKey,
    })
  ) {
    throw new InvalidUpdateResponseError(
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
    catalogId,
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
    catalogId,
    catalogHash: catalog.catalogHash,
    channel: input.targetChannel,
    generation: catalog.generation,
    scopeKey,
    selectionContextHash,
  };
  const fromReleaseId =
    active?.bundleId === input.currentBundleId
      ? active.releaseId
      : activeState.stableSelection?.bundleId === input.currentBundleId
        ? activeState.stableSelection.releaseId
        : null;
  const errorScope = {
    bundleId: input.currentBundleId,
    channel: input.targetChannel,
    targetBundleId: desired.bundleId,
    targetReleaseId: desired.releaseId,
    updateStrategy: options.updateStrategy,
  };
  const installSelection = async (): Promise<boolean> => {
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
        emitAfterAppReady("onUpdateCheck", () => ({
          status: "UNCHANGED",
          channel: receipt.channel,
          bundleId: receipt.bundleId,
          releaseId: receipt.releaseId,
          previousReleaseId: active?.releaseId ?? null,
        }));
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
    const delivery = await stageBundle({
      assets: artifact.assets,
      bundleId: desired.bundleId,
      channel: input.targetChannel,
      manifestFileHash: artifact.manifestFileHash,
      manifestUrl: artifact.manifestUrl,
      ...(artifact.archiveUrl ? { archiveUrl: artifact.archiveUrl } : {}),
      selection: receipt,
      shouldSkipCurrentBundleIdCheck: true,
      status: desired.status,
    });
    if (delivery !== null && desired.bundleId !== input.currentBundleId) {
      emitAfterAppReady("onBundleDownloaded", () => ({
        channel: input.targetChannel,
        fromBundleId: input.currentBundleId,
        fromReleaseId,
        toBundleId: desired.bundleId,
        toReleaseId: desired.releaseId,
        updateStrategy: options.updateStrategy,
        ...delivery,
      }));
    }
    return true;
  };
  const updateBundleForSelection = async (): Promise<boolean> => {
    try {
      return await installSelection();
    } catch (error) {
      reportUpdateError(error, "download", "artifact", errorScope);
      throw error;
    }
  };

  const shouldForceUpdate =
    transitionKind === "ADOPT_RELEASE"
      ? false
      : desired.status === "ROLLBACK"
        ? true
        : (release?.shouldForceUpdate ?? false);
  emitAfterAppReady("onUpdateCheck", () => ({
    status: "UPDATE_AVAILABLE",
    channel: input.targetChannel,
    fromBundleId: input.currentBundleId,
    fromReleaseId,
    toBundleId: desired.bundleId,
    toReleaseId: desired.releaseId,
    transitionKind,
    updateStatus: desired.status,
    shouldForceUpdate,
    updateStrategy: options.updateStrategy,
  }));

  return {
    id: desired.releaseId ?? desired.bundleId,
    message: release?.message ?? null,
    releaseId: desired.releaseId,
    rolloutCohortCount: release?.rolloutCohortCount ?? 1000,
    shouldForceUpdate,
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
  const minimumReleaseId = getMinBundleId();
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
    const result = await checkForReleaseCatalogUpdate({
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
    if (result === null) {
      emitAfterAppReady("onUpdateCheck", () => {
        const releaseId = getRunningReleaseId(currentBundleId, currentChannel);
        return {
          status: "UNCHANGED",
          channel: currentChannel,
          bundleId: currentBundleId,
          releaseId,
          previousReleaseId: releaseId,
        };
      });
    }
    return result;
  } catch (error) {
    reportUpdateError(error, "check", "catalog", {
      bundleId: currentBundleId,
      channel: targetChannel,
      updateStrategy: options.updateStrategy,
    });
    options.onError?.(error as Error);
    return null;
  }
}
