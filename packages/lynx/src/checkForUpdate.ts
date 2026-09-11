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
  HotUpdaterOptions,
  InstallResult,
  NativeState,
  PreparedUpdate,
  PrepareSelectionParams,
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

export async function checkForUpdate(
  options: HotUpdaterOptions,
): Promise<PreparedUpdate | null> {
  const state = await callNative<NativeState>("getState");
  const http = createHttpClient(options);
  const catalog = await http.fetchCatalog(state);
  // Policy may replace an installed next selection. Running bytes stay separate.
  const current = state.nextSelection ?? state.runningSelection;
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
    strategy: "APP_VERSION",
    strategyValue: state.appVersion,
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
  if (
    desired === null ||
    (desired.kind === "BUILTIN" &&
      current.kind === "BUILTIN" &&
      current.bundleId === state.embeddedBundleId)
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
    channel: state.channel,
    selectionContextHash,
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
  let installation: Promise<InstallResult> | undefined;
  return {
    bundleId: desired.bundleId,
    releaseId: desired.releaseId,
    status: desired.status,
    message: desired.release?.message ?? null,
    shouldForceUpdate: canRequestAdoption
      ? false
      : desired.status === "ROLLBACK" ||
        (desired.release?.shouldForceUpdate ?? false),
    install: () =>
      (installation ??= callNative<InstallResult>("stageSelection", {
        preparedId,
      })),
  };
}
