import {
  authorizeReleaseTransition,
  createReleaseSelectionContextHash,
  encodeChannelKey,
  selectDesiredRelease,
  type PersistedSelectionReceipt,
} from "@hot-updater/core";

import { createHttpClient } from "./httpClient";
import { callNative, LynxUpdaterError, normalizeNativeState } from "./native";
import type {
  AcceptCatalogParams,
  CheckForUpdateOptions,
  CheckForUpdateResult,
  HotUpdaterOptions,
  InstallResult,
  NativeState,
  PrepareSelectionParams,
  ReleaseTransitionKind,
  SelectionGuard,
} from "./types";

function sameReceipt(
  current: PersistedSelectionReceipt,
  desired: PersistedSelectionReceipt,
): boolean {
  return (Object.keys(desired) as (keyof PersistedSelectionReceipt)[]).every(
    (key) => current[key] === desired[key],
  );
}

export interface InternalCheckForUpdateOptions extends CheckForUpdateOptions {
  client: HotUpdaterOptions;
}

export async function checkForUpdate(
  options: InternalCheckForUpdateOptions,
): Promise<CheckForUpdateResult | null> {
  if (
    options.updateStrategy !== "appVersion" &&
    options.updateStrategy !== "fingerprint"
  ) {
    throw new LynxUpdaterError(
      "UNSUPPORTED_STRATEGY",
      'Lynx updates use updateStrategy: "appVersion" or "fingerprint".',
    );
  }
  const state = normalizeNativeState(await callNative<NativeState>("getState"));
  const explicitChannel = options.channel || undefined;
  const targetChannel = explicitChannel ?? state.channel;
  const explicitScopeSwitch = targetChannel !== state.channel;
  const defaultChannel = state.defaultChannel ?? state.channel;
  if (state.channel !== defaultChannel && explicitScopeSwitch) {
    throw new LynxUpdaterError(
      "CHANNEL_ALREADY_SWITCHED",
      `Runtime channel is already switched to "${state.channel}". Call HotUpdater.resetChannel() before checking "${targetChannel}".`,
    );
  }
  const http = createHttpClient({
    ...options.client,
    requestHeaders: {
      ...options.client.requestHeaders,
      ...options.requestHeaders,
    },
    requestTimeout: options.requestTimeout ?? options.client.requestTimeout,
  });
  const catalogState = explicitScopeSwitch
    ? {
        ...state,
        channel: targetChannel,
        channelKey: encodeChannelKey(targetChannel),
      }
    : state;
  const catalog = await http.fetchCatalog(
    catalogState,
    options.updateStrategy === "fingerprint" ? "fingerprint" : "app-version",
  );
  // Policy may replace an installed next selection. Running bytes stay separate.
  // A leftover next from another channel is not the target policy base.
  const next = state.nextSelection;
  const current =
    next !== null && next.channel === targetChannel
      ? next
      : state.runningSelection;
  const authenticated = current.catalogId !== null && current.scopeKey !== null;
  const activeInTargetScope =
    authenticated &&
    current.catalogId === catalog.catalogId &&
    current.scopeKey === catalog.scopeKey
      ? current
      : null;
  if (authenticated && activeInTargetScope === null && !explicitScopeSwitch) {
    throw new LynxUpdaterError(
      "UNSOLICITED_SCOPE",
      "The catalog does not match the native selection scope.",
    );
  }
  const selectorCurrentBundleId =
    activeInTargetScope !== null || (!authenticated && !explicitScopeSwitch)
      ? current.bundleId
      : state.minimumBundleId;
  const selectionContextHash = createReleaseSelectionContextHash({
    activeBundleId: selectorCurrentBundleId,
    activeReleaseId: activeInTargetScope?.releaseId ?? null,
    cohort: state.cohort,
    minimumReleaseId: state.minimumBundleId,
    strategy:
      options.updateStrategy === "fingerprint" ? "FINGERPRINT" : "APP_VERSION",
    strategyValue:
      options.updateStrategy === "fingerprint"
        ? (state.fingerprintHash ?? "")
        : state.appVersion,
    crashedBundleIds: state.crashedBundleIds,
    unconfirmedReleaseIds: state.unconfirmedReleaseIds,
  });
  const guard = await callNative<SelectionGuard>("acceptCatalog", {
    catalog,
    expectedRevision: state.revision,
    explicitScopeSwitch,
    selectionContextHash,
    targetChannel,
  } satisfies AcceptCatalogParams);
  const desired = selectDesiredRelease(catalog, {
    activeReleaseId: activeInTargetScope?.releaseId ?? null,
    builtInBundleId: state.embeddedBundleId,
    currentBundleId: selectorCurrentBundleId,
    minimumReleaseId: state.minimumBundleId,
    cohort: state.cohort,
    crashedBundleIds: state.crashedBundleIds,
    unconfirmedReleaseIds: state.unconfirmedReleaseIds,
  });
  if (desired === null) {
    return null;
  }
  const hasCoveredBundle =
    state.confirmedSelection?.kind === "BUNDLE" ||
    state.nextSelection?.kind === "BUNDLE";
  if (
    desired.kind === "BUILTIN" &&
    current.kind === "BUILTIN" &&
    current.bundleId === state.embeddedBundleId &&
    !hasCoveredBundle
  ) {
    return null;
  }
  const selection: PersistedSelectionReceipt = {
    kind: desired.kind,
    bundleId: desired.bundleId,
    releaseId: desired.releaseId,
    catalogId: catalog.catalogId,
    scopeKey: catalog.scopeKey,
    generation: catalog.generation,
    catalogHash: catalog.catalogHash,
    channel: targetChannel,
    selectionContextHash: guard.selectionContextHash ?? selectionContextHash,
  };
  if (sameReceipt(current, selection) && !hasCoveredBundle) return null;
  const authorization = authorizeReleaseTransition({
    active: authenticated ? current : null,
    desired: selection,
    explicitScopeSwitch,
  });
  if (!authorization.authorized) {
    if (authorization.reason === "EMPTY_TARGET_SCOPE") return null;
    throw new LynxUpdaterError(
      authorization.reason,
      `Release transition rejected: ${authorization.reason}.`,
    );
  }

  const canRequestAdoption =
    desired.kind === "BUNDLE" &&
    state.runningConfirmed &&
    state.runningSelection.bundleId === desired.bundleId;
  const artifact =
    desired.kind !== "BUNDLE" || canRequestAdoption
      ? null
      : await http.resolveArtifact(
          desired.bundleId,
          state.runningSelection.bundleId,
        );
  const preparation = {
    guard,
    selection,
    artifact,
  } satisfies PrepareSelectionParams;
  const validation = await callNative<{ validated: true }>(
    "validateSelection",
    preparation,
  );
  if (validation?.validated !== true) {
    throw new LynxUpdaterError(
      "INVALID_NATIVE_REPLY",
      "Native validation did not confirm the selected update.",
    );
  }
  let installation: Promise<boolean> | undefined;
  const prepareAndInstall = async (): Promise<boolean> => {
    // A declined update retains no native preparation. Once requested, native
    // prepares and immediately consumes the token by staging the same receipt.
    const prepared = await callNative<{ preparedId: string }>(
      "prepareSelection",
      preparation,
    );
    if (typeof prepared?.preparedId !== "string" || !prepared.preparedId) {
      throw new LynxUpdaterError(
        "INVALID_NATIVE_REPLY",
        "Native preparation did not return a prepared selection token.",
      );
    }
    const result = await callNative<InstallResult>("stageSelection", {
      preparedId: prepared.preparedId,
    });
    return result.status === "STAGED" || result.status === "ADOPTED";
  };
  const transitionKind: ReleaseTransitionKind = canRequestAdoption
    ? "ADOPT_RELEASE"
    : desired.kind === "EMBEDDED"
      ? "USE_EMBEDDED"
      : desired.kind === "BUILTIN"
        ? "USE_BUILTIN"
        : "INSTALL";
  return {
    id: desired.releaseId ?? desired.bundleId,
    bundleId: desired.bundleId,
    fileHash: artifact?.fileHash ?? null,
    fileUrl: artifact?.fileUrl ?? null,
    message: desired.release?.message ?? null,
    releaseId: desired.releaseId,
    rolloutCohortCount: desired.release?.rolloutCohortCount ?? 1000,
    shouldForceUpdate: canRequestAdoption
      ? false
      : desired.status === "ROLLBACK" ||
        (desired.release?.shouldForceUpdate ?? false),
    status: desired.status,
    targetCohorts: desired.release?.targetCohorts
      ? [...desired.release.targetCohorts]
      : [],
    transitionKind,
    updateBundle: () => (installation ??= prepareAndInstall()),
  };
}
