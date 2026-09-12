import {
  authorizeReleaseTransition,
  createReleaseSelectionContextHash,
  selectDesiredRelease,
  type PersistedSelectionReceipt,
} from "@hot-updater/core";

import { createHttpClient } from "./httpClient";
import { callNative, LynxUpdaterError } from "./native";
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
  let state = await callNative<NativeState>("getState");
  if (options.channel && options.channel !== state.channel) {
    state = await callNative<NativeState>("setChannel", {
      channel: options.channel,
    });
  }
  const http = createHttpClient({
    ...options.client,
    requestHeaders: {
      ...options.client.requestHeaders,
      ...options.requestHeaders,
    },
    requestTimeout: options.requestTimeout ?? options.client.requestTimeout,
  });
  const catalog = await http.fetchCatalog(
    state,
    options.updateStrategy === "fingerprint" ? "fingerprint" : "app-version",
  );
  // Policy may replace an installed next selection. Running bytes stay separate.
  // A leftover next from another channel is not the policy base after setChannel.
  const next = state.nextSelection;
  const current =
    next !== null && next.channel === state.channel
      ? next
      : state.runningSelection;
  const authenticated = current.catalogId !== null && current.scopeKey !== null;
  if (
    authenticated &&
    (current.catalogId !== catalog.catalogId ||
      current.scopeKey !== catalog.scopeKey)
  ) {
    throw new LynxUpdaterError(
      "UNSOLICITED_SCOPE",
      "The catalog does not match the native selection scope.",
    );
  }
  const selectionContextHash = createReleaseSelectionContextHash({
    activeBundleId: current.bundleId,
    activeReleaseId: authenticated ? current.releaseId : null,
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
    selectionContextHash,
  } satisfies AcceptCatalogParams);
  const desired = selectDesiredRelease(catalog, {
    activeReleaseId: authenticated ? current.releaseId : null,
    builtInBundleId: state.embeddedBundleId,
    currentBundleId: current.bundleId,
    minimumReleaseId: state.minimumBundleId,
    cohort: state.cohort,
    crashedBundleIds: state.crashedBundleIds,
    unconfirmedReleaseIds: state.unconfirmedReleaseIds,
  });
  if (desired === null) {
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
    channel: state.channel,
    selectionContextHash: guard.selectionContextHash ?? selectionContextHash,
  };
  if (sameReceipt(current, selection)) return null;
  const authorization = authorizeReleaseTransition({
    active: authenticated ? current : null,
    desired: selection,
    explicitScopeSwitch: false,
  });
  if (!authorization.authorized) {
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
  // Native prepares verified bytes and retains the receipt/guard behind a token.
  // INCOMPATIBLE and stale authorization reject here without changing selection.
  const prepared = await callNative<{ preparedId: string }>(
    "prepareSelection",
    {
      guard,
      selection,
      artifact,
    } satisfies PrepareSelectionParams,
  );
  if (typeof prepared?.preparedId !== "string" || !prepared.preparedId) {
    throw new LynxUpdaterError(
      "INVALID_NATIVE_REPLY",
      "Native preparation did not return a prepared selection token.",
    );
  }
  const preparedId = prepared.preparedId;
  let installation: Promise<boolean> | undefined;
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
    updateBundle: () =>
      (installation ??= callNative<InstallResult>("stageSelection", {
        preparedId,
      }).then(
        (result) => result.status === "STAGED" || result.status === "ADOPTED",
      )),
  };
}
