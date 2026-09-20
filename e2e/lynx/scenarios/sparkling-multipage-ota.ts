import {
  LYNX_E2E_BUILTIN_BUNDLE_ID,
  lynxE2eRuntimeId,
} from "../embedded-bundle.ts";
import type { LynxAppDriver } from "../lynx-app-driver.ts";
import {
  assertManagedDetailClosed,
  assertManagedDetailPending,
  assertManagedDetailOpened,
  assertManagedInstallRejected,
  assertManagedMainPage,
  assertManagedOldAuthoritiesRejected,
  assertManagedPageTerminal,
  assertManagedPendingTransition,
  assertManagedReconstructedStack,
  assertManagedTransition,
  assertManagedTransitionCancellation,
  assertManagedVerifiedFatalDetail,
  type ManagedPageIdentity,
  type ManagedPendingPageIdentity,
  type ManagedSelection,
} from "../multipage-evidence.ts";
import {
  validateNavigationStackBoundary,
  validateRuntimeJournalDiagnostics,
} from "../native-diagnostics-evidence.ts";

async function openPendingDetail(
  app: LynxAppDriver,
  label: string,
  marker: string,
  main: ManagedPageIdentity,
): Promise<ManagedPendingPageIdentity> {
  await app.tap(
    `${label}: arm pending detail admission`,
    "action-arm-next-detail-pending",
  );
  await app.openDetailPage(`${label}: open pending managed detail`, marker);
  return assertManagedDetailPending(
    await app.captureGenerationEvents(`${label}: capture pending detail`),
    { platform: app.platformName, main },
  );
}

const navigationBoundaryParameters = (
  vector:
    | "canonical-options"
    | "parameter-count"
    | "key-bytes"
    | "value-bytes"
    | "decoded-query-bytes"
    | "raw-route-bytes",
): Readonly<Record<string, string>> => {
  if (vector === "canonical-options") {
    return { title: "Second Page", value: "a+b" };
  }
  if (vector === "parameter-count") {
    return Object.fromEntries(
      Array.from({ length: 32 }, (_, index) => [`p${index}`, String(index)]),
    );
  }
  if (vector === "key-bytes") return { ["é".repeat(64)]: "ok" };
  if (vector === "value-bytes") return { value: "é".repeat(512) };
  if (vector === "decoded-query-bytes") {
    return { a: "a".repeat(1_024), b: "b".repeat(998) };
  }
  return { a: "é".repeat(512), b: "b".repeat(970) };
};

async function waitForManagedDetailOpened(
  app: LynxAppDriver,
  stage: string,
  options: {
    readonly platform: "ios" | "android";
    readonly main: ManagedPageIdentity;
    readonly expectedParameters: Readonly<Record<string, string>>;
  },
): Promise<ManagedPageIdentity> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    const snapshot = await app.captureGenerationEvents(
      attempt === 1 ? stage : `${stage} retry ${attempt}`,
    );
    try {
      return assertManagedDetailOpened(snapshot, options);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw lastError;
}

async function resetAndInstallServerA(
  app: LynxAppDriver,
  marker: string,
): Promise<ManagedPageIdentity> {
  await app.control(
    "multi-page lifecycle: clear local candidate outcomes",
    "/e2e/reset-local-app-state",
  );
  await app.launch("multi-page lifecycle: relaunch embedded A");
  const embedded = assertManagedMainPage(
    await app.captureGenerationEvents(
      "multi-page lifecycle: capture reset embedded A",
    ),
    {
      bundleId: app.readScenarioString("embeddedBundleA"),
      releaseId: null,
    },
  );
  await installAndReload(
    app,
    "multi-page lifecycle server A",
    marker,
    "bundleA",
    "releaseA",
  );
  const selectionA = selection(app, "bundleA", "releaseA");
  const events = await app.captureGenerationEvents(
    "multi-page lifecycle: capture server A replacement",
  );
  return assertManagedTransition(events, {
    before: embedded,
    after: selectionA,
  });
}

async function provePageCycle(
  app: LynxAppDriver,
  label: string,
  marker: string,
  selection: ManagedSelection,
  closeWith: "back" | "close",
): Promise<ManagedPageIdentity> {
  const beforeOpen = await app.captureGenerationEvents(
    `${label}: capture main native evidence`,
  );
  const main = assertManagedMainPage(beforeOpen, selection);
  await app.openDetailPage(`${label}: open managed detail`, marker);
  const opened = await app.captureGenerationEvents(
    `${label}: capture detail native evidence`,
  );
  const detail = assertManagedDetailOpened(opened, {
    platform: app.platformName,
    main,
  });
  if (closeWith === "back") {
    await app.nativeBack(`${label}: native back from detail`);
  } else {
    await app.closeDetailPage(`${label}: close detail through router`);
  }
  const closed = await app.captureGenerationEvents(
    `${label}: capture detail close evidence`,
  );
  assertManagedDetailClosed(closed, {
    platform: app.platformName,
    detail,
    cause: closeWith,
  });
  return main;
}

export async function installAndReload(
  app: LynxAppDriver,
  label: string,
  marker: string,
  bundleKey: string,
  releaseKey: string,
  options: {
    readonly diffBaseBundleKey?: string;
    readonly diffPatchAssetPathKey?: string;
    readonly proveOffline?: boolean;
  } = {},
): Promise<void> {
  await app.tap(
    `${label}: install selected Release`,
    "action-install-current-channel-update",
  );
  await app.assertText(
    `${label}: assert installed Release`,
    "update-action-result",
    `$${releaseKey}`,
  );
  if (options.diffBaseBundleKey) {
    if (!options.diffPatchAssetPathKey) {
      throw new Error(`${label}: delta proof requires its exact patch path`);
    }
    await app.control(
      `${label}: prove mixed multi-page delta selection`,
      "/e2e/assert-bundle-artifact-selection",
      {
        currentBundleId: `$${options.diffBaseBundleKey}`,
        requireArchiveAbsent: true,
        requiredPatchAssetPaths: ["main.lynx.bundle"],
        requiredRawAssetPaths: ["detail.lynx.bundle"],
        selection: "manifest-diff",
        targetBundleId: `$${bundleKey}`,
      },
    );
  }
  await app.control(
    `${label}: wait staging pending`,
    "/e2e/jobs/wait-for-metadata",
    {
      bundleId: `$${bundleKey}`,
      verificationPending: true,
    },
  );
  if (options.proveOffline) {
    await app.control(
      `${label}: make artifacts unavailable`,
      "/e2e/proxy-control",
      { artifactFailures: 1, reset: true },
    );
  }
  await app.reloadManagedGeneration(`${label}: replace generation`, marker);
  if (options.proveOffline) {
    await app.control(
      `${label}: prove offline activation`,
      "/e2e/assert-proxy",
      { artifactFailuresRemaining: 1, artifactRequests: 0 },
    );
    await app.control(`${label}: restore transport`, "/e2e/proxy-control", {
      reset: true,
    });
  }
  await app.control(
    `${label}: wait staging stable`,
    "/e2e/jobs/wait-for-metadata",
    {
      bundleId: `$${bundleKey}`,
      verificationPending: false,
    },
  );
  await app.assertText(
    `${label}: assert active marker`,
    "runtime-scenario-marker",
    marker,
    { exactText: true },
  );
  await app.assertText(
    `${label}: assert active bundle`,
    "runtime-bundle-id",
    `$${bundleKey}`,
    { exactText: true },
  );
  await app.assertText(
    `${label}: assert active Release`,
    "runtime-release-state",
    `$${releaseKey}`,
    { exactText: true },
  );
  if (options.diffBaseBundleKey) {
    await app.control(
      `${label}: prove native main BSDIFF application`,
      "/e2e/assert-bsdiff-patch-applied",
      {
        assetPath: `$${options.diffPatchAssetPathKey}`,
        baseBundleId: `$${options.diffBaseBundleKey}`,
        bundleId: `$${bundleKey}`,
      },
    );
    await app.control(
      `${label}: prove both page resources committed atomically`,
      "/e2e/assert-bundle-assets-stored",
      {
        assetPaths: ["main.lynx.bundle", "detail.lynx.bundle"],
        bundleId: `$${bundleKey}`,
      },
    );
  }
}

const selection = (
  app: LynxAppDriver,
  bundleKey: string,
  releaseKey: string,
): ManagedSelection => ({
  bundleId: app.readScenarioString(bundleKey),
  releaseId: app.readScenarioString(releaseKey),
});

async function rejectInvalidDetailTarget(
  app: LynxAppDriver,
  label: string,
  mode: "corrupt" | "missing",
  running: ManagedPageIdentity,
  rejected: ManagedSelection,
): Promise<void> {
  const before = await app.captureGenerationEvents(
    `${label} ${mode} detail: capture native baseline`,
  );
  await app.control(
    `${label} ${mode} detail: inject changed asset failure`,
    "/e2e/proxy-control",
    {
      changedAssetMutation: {
        assetPath: "detail.lynx.bundle",
        mode,
        remaining: 1,
      },
      reset: true,
    },
  );
  await app.tap(
    `${label} ${mode} detail: reject atomic install`,
    "action-install-current-channel-update",
    { allowErrorResult: true },
  );
  await app.assertText(
    `${label} ${mode} detail: require install rejection`,
    "update-action-result",
    [" -> error", " -> skipped"],
  );
  await app.assertText(
    `${label} ${mode} detail: preserve running bundle`,
    "runtime-bundle-id",
    running.bundleId,
    { exactText: true },
  );
  await app.assertText(
    `${label} ${mode} detail: preserve running Release`,
    "runtime-release-state",
    running.releaseId ?? "BUILTIN",
    { exactText: true },
  );
  await app.control(
    `${label} ${mode} detail: prove no archive fallback`,
    "/e2e/assert-bundle-artifact-selection",
    {
      currentBundleId: running.bundleId,
      requireArchiveAbsent: true,
      requiredPatchAssetPaths: ["main.lynx.bundle"],
      requiredRawAssetPaths: ["detail.lynx.bundle"],
      selection: "manifest-diff",
      targetBundleId: rejected.bundleId,
    },
  );
  await app.control(
    `${label} ${mode} detail: prove injected response consumed`,
    "/e2e/assert-proxy",
    {
      changedAssetMutationMode: mode,
      changedAssetMutationRemaining: 0,
    },
  );
  const after = await app.captureGenerationEvents(
    `${label} ${mode} detail: capture rejection evidence`,
  );
  assertManagedInstallRejected(before, after, { rejected, running });
}

export const sparklingMultipageOtaScenario = {
  name: "sparkling-multipage-ota",
  run: async (app: LynxAppDriver): Promise<void> => {
    await app.control(
      "multi-page: capture embedded bundle",
      "/e2e/capture-built-in-bundle-id",
      {},
      { saveResultAs: "embeddedBundleA" },
    );
    await app.launch("multi-page A: launch embedded generation");
    const markerA = app.readScenarioString("initialMarker");
    const observedBundleA = app.readScenarioString("embeddedBundleA");
    if (observedBundleA !== LYNX_E2E_BUILTIN_BUNDLE_ID) {
      throw new Error(
        "The shipped Lynx multi-page suite must start from embedded A",
      );
    }
    await app.assertText(
      "multi-page A: assert embedded marker",
      "runtime-scenario-marker",
      markerA,
      { exactText: true },
    );
    const mainA = await provePageCycle(
      app,
      "multi-page A",
      markerA,
      { bundleId: observedBundleA, releaseId: null },
      "close",
    );
    for (const vector of [
      "canonical-options",
      "parameter-count",
      "key-bytes",
      "value-bytes",
      "decoded-query-bytes",
      "raw-route-bytes",
    ] as const) {
      await app.control(
        `multi-page navigation ${vector}: reset detail observation`,
        "/e2e/screen-state",
        { detailPageMarker: null, detailPageTitle: null },
      );
      await app.tap(
        `multi-page navigation ${vector}: accept exact max and reject overflow`,
        "action-verify-managed-navigation-boundary",
      );
      await app.assertText(
        `multi-page navigation ${vector}: prove public boundary result`,
        "update-action-result",
        `Navigation boundary ${vector}: max accepted, plus one rejected`,
        { exactText: true },
      );
      await app.waitForDetailAdmission(
        `multi-page navigation ${vector}: wait for native detail`,
        markerA,
      );
      const boundaryDetail = await waitForManagedDetailOpened(
        app,
        `multi-page navigation ${vector}: capture native page evidence`,
        {
          platform: app.platformName,
          main: mainA,
          expectedParameters: navigationBoundaryParameters(vector),
        },
      );
      await app.closeDetailPage(
        `multi-page navigation ${vector}: close accepted page`,
      );
      assertManagedDetailClosed(
        await app.captureGenerationEvents(
          `multi-page navigation ${vector}: capture close evidence`,
        ),
        { platform: app.platformName, detail: boundaryDetail, cause: "close" },
      );
    }

    validateNavigationStackBoundary(
      await app.captureDiagnosticReceipt(
        "multi-page navigation stack: accept depth 16 and reject depth 17",
        "action-exercise-navigation-stack-boundary",
      ),
    );
    for (let depth = 16; depth > 1; depth -= 1) {
      await app.nativeBack(`multi-page navigation stack: close depth ${depth}`);
    }
    assertManagedMainPage(
      await app.captureGenerationEvents(
        "multi-page navigation stack: prove original main remains top",
      ),
      { bundleId: observedBundleA, releaseId: null },
    );

    validateRuntimeJournalDiagnostics(
      await app.captureDiagnosticReceipt(
        "multi-page runtime journal: exercise retention and repair boundaries",
        "action-exercise-runtime-journal",
      ),
    );

    const afterJournal = await app.captureGenerationEvents(
      "multi-page runtime journal: prove live generation remains readable",
    );
    if (afterJournal.latestSequence === null) {
      throw new Error(
        "Runtime journal restore left no native generation events",
      );
    }

    await app.control(
      "multi-page server A: deploy",
      "/e2e/jobs/deploy-bundle",
      {
        channel: "production",
        marker: markerA,
        mode: "reset",
        safeBundleIds: [],
        targetAppVersion: "1.0.x",
      },
      {
        saveResultAs: "bundleA",
        saveResultFieldsAs: { releaseId: "releaseA" },
      },
    );
    if (app.readScenarioString("bundleA") !== observedBundleA) {
      throw new Error(
        "Server Release A must register the exact embedded multi-page Bundle A",
      );
    }

    await app.control(
      "multi-page cross-provenance: deploy deterministic incompatible target",
      "/e2e/jobs/deploy-bundle",
      {
        channel: "production",
        crossProvenance: true,
        marker: "sparkling-multipage-incompatible",
        mode: "reset",
        safeBundleIds: ["$bundleA"],
        targetAppVersion: "1.0.x",
      },
      {
        saveResultAs: "incompatibleBundle",
        saveResultFieldsAs: {
          releaseId: "incompatibleRelease",
          runtimeId: "incompatibleRuntime",
        },
      },
    );
    const incompatibleRuntime = app.readScenarioString("incompatibleRuntime");
    if (
      incompatibleRuntime !==
      `${lynxE2eRuntimeId(app.platformName)}-cross-provenance-rejected`
    ) {
      throw new Error(
        "Cross-provenance deploy did not use the fixed test vector",
      );
    }
    const beforeIncompatible = await app.captureGenerationEvents(
      "multi-page cross-provenance: capture running embedded generation",
    );
    await app.tap(
      "multi-page cross-provenance: invoke ordinary updater install",
      "action-install-current-channel-update",
      { allowErrorResult: true },
    );
    await app.assertText(
      "multi-page cross-provenance: require native incompatibility rejection",
      "update-action-result",
      ["INCOMPATIBLE", "incompatible"],
    );
    await app.assertText(
      "multi-page cross-provenance: preserve embedded Bundle",
      "runtime-bundle-id",
      observedBundleA,
      { exactText: true },
    );
    const afterIncompatible = await app.captureGenerationEvents(
      "multi-page cross-provenance: capture unchanged native generation",
    );
    assertManagedInstallRejected(beforeIncompatible, afterIncompatible, {
      rejected: selection(app, "incompatibleBundle", "incompatibleRelease"),
      running: mainA,
    });
    await app.control(
      "multi-page cross-provenance: disable incompatible Release",
      "/e2e/jobs/patch-release",
      { enabled: false, releaseId: "$incompatibleRelease" },
    );

    await app.control(
      "multi-page B: deploy",
      "/e2e/jobs/deploy-bundle",
      {
        channel: "production",
        marker: "sparkling-multipage-b",
        diffBaseBundleId: "$bundleA",
        mode: "reset",
        patchMaxBaseBundles: 2,
        safeBundleIds: ["$bundleA"],
        targetAppVersion: "1.0.x",
      },
      {
        saveResultAs: "bundleB",
        saveResultFieldsAs: {
          diffPatchAssetPath: "patchAToB",
          releaseId: "releaseB",
        },
      },
    );
    await installAndReload(
      app,
      "multi-page B",
      "sparkling-multipage-b",
      "bundleB",
      "releaseB",
      {
        diffBaseBundleKey: "bundleA",
        diffPatchAssetPathKey: "patchAToB",
        proveOffline: true,
      },
    );
    const selectionB = selection(app, "bundleB", "releaseB");
    const evidenceB = await app.captureGenerationEvents(
      "multi-page B: capture replacement evidence",
    );
    assertManagedTransition(evidenceB, { before: mainA, after: selectionB });
    const mainB = await provePageCycle(
      app,
      "multi-page B",
      "sparkling-multipage-b",
      selectionB,
      "back",
    );
    await app.openDetailPage(
      "multi-page B to C: keep managed detail open",
      "sparkling-multipage-b",
    );
    const openBEvents = await app.captureGenerationEvents(
      "multi-page B to C: capture open native stack",
    );
    const openBDetail = assertManagedDetailOpened(openBEvents, {
      platform: app.platformName,
      main: mainB,
    });

    await app.control(
      "multi-page C: deploy",
      "/e2e/jobs/deploy-bundle",
      {
        channel: "production",
        diffBaseBundleId: "$bundleB",
        marker: "sparkling-multipage-c",
        mode: "reset",
        patchMaxBaseBundles: 2,
        safeBundleIds: ["$bundleA", "$bundleB"],
        targetAppVersion: "1.0.x",
      },
      {
        saveResultAs: "bundleC",
        saveResultFieldsAs: {
          diffPatchAssetPath: "patchBToC",
          releaseId: "releaseC",
        },
      },
    );
    await app.control(
      "multi-page: create C to B reverse patch",
      "/e2e/jobs/create-bundle-diff",
      { baseBundleId: "$bundleC", bundleId: "$bundleB" },
      { saveResultFieldsAs: { patchAssetPath: "patchCToB" } },
    );
    await app.control(
      "multi-page: create B to server A reverse patch",
      "/e2e/jobs/create-bundle-diff",
      { baseBundleId: "$bundleB", bundleId: "$bundleA" },
      { saveResultFieldsAs: { patchAssetPath: "patchBToA" } },
    );
    const selectionC = selection(app, "bundleC", "releaseC");
    await rejectInvalidDetailTarget(
      app,
      "multi-page C",
      "missing",
      mainB,
      selectionC,
    );
    await rejectInvalidDetailTarget(
      app,
      "multi-page C",
      "corrupt",
      mainB,
      selectionC,
    );
    await app.control(
      "multi-page C: restore artifact transport",
      "/e2e/proxy-control",
      { reset: true },
    );
    await installAndReload(
      app,
      "multi-page C",
      "sparkling-multipage-c",
      "bundleC",
      "releaseC",
      {
        diffBaseBundleKey: "bundleB",
        diffPatchAssetPathKey: "patchBToC",
      },
    );
    const cReplacementEvents = await app.captureGenerationEvents(
      "multi-page C: capture reconstructed replacement evidence",
    );
    const mainC = assertManagedTransition(cReplacementEvents, {
      before: mainB,
      after: selectionC,
    });
    const reconstructedCDetail = assertManagedDetailOpened(cReplacementEvents, {
      platform: app.platformName,
      main: mainC,
    });
    if (reconstructedCDetail.contextId === openBDetail.contextId) {
      throw new Error(
        "Managed reload reused the old detail context instead of reconstructing it",
      );
    }
    await app.closeDetailPage(
      "multi-page C: close reconstructed managed detail",
    );
    assertManagedDetailClosed(
      await app.captureGenerationEvents(
        "multi-page C: capture reconstructed detail close",
      ),
      {
        platform: app.platformName,
        detail: reconstructedCDetail,
        cause: "close",
      },
    );

    await app.control("multi-page: disable C", "/e2e/jobs/patch-release", {
      enabled: false,
      releaseId: "$releaseC",
    });
    await rejectInvalidDetailTarget(
      app,
      "multi-page rollback B",
      "missing",
      mainC,
      selectionB,
    );
    await rejectInvalidDetailTarget(
      app,
      "multi-page rollback B",
      "corrupt",
      mainC,
      selectionB,
    );
    await app.control(
      "multi-page rollback B: restore artifact transport",
      "/e2e/proxy-control",
      { reset: true },
    );
    await installAndReload(
      app,
      "multi-page rollback B",
      "sparkling-multipage-b",
      "bundleB",
      "releaseB",
      {
        diffBaseBundleKey: "bundleC",
        diffPatchAssetPathKey: "patchCToB",
      },
    );
    assertManagedTransition(
      await app.captureGenerationEvents(
        "multi-page rollback B: capture replacement evidence",
      ),
      { before: mainC, after: selectionB },
    );
    const rollbackB = await provePageCycle(
      app,
      "multi-page rollback B",
      "sparkling-multipage-b",
      selectionB,
      "back",
    );

    await app.control("multi-page: disable B", "/e2e/jobs/patch-release", {
      enabled: false,
      releaseId: "$releaseB",
    });
    const selectionA = selection(app, "bundleA", "releaseA");
    await rejectInvalidDetailTarget(
      app,
      "multi-page rollback server A",
      "missing",
      rollbackB,
      selectionA,
    );
    await rejectInvalidDetailTarget(
      app,
      "multi-page rollback server A",
      "corrupt",
      rollbackB,
      selectionA,
    );
    await app.control(
      "multi-page rollback server A: restore artifact transport",
      "/e2e/proxy-control",
      { reset: true },
    );
    await installAndReload(
      app,
      "multi-page rollback server A",
      markerA,
      "bundleA",
      "releaseA",
      {
        diffBaseBundleKey: "bundleB",
        diffPatchAssetPathKey: "patchBToA",
      },
    );
    const evidenceA = await app.captureGenerationEvents(
      "multi-page rollback server A: capture replacement evidence",
    );
    assertManagedTransition(evidenceA, {
      before: rollbackB,
      after: selectionA,
    });
    const serverAMain = await provePageCycle(
      app,
      "multi-page rollback server A",
      markerA,
      selectionA,
      "close",
    );

    const pendingClose = await openPendingDetail(
      app,
      "multi-page pending close",
      markerA,
      serverAMain,
    );
    await app.closeDetailPage("multi-page pending close: Sparkling close");
    const pendingCloseEvents = await app.captureGenerationEvents(
      "multi-page pending close: capture terminal",
    );
    assertManagedPageTerminal(pendingCloseEvents, pendingClose, {
      reason: "sparklingClose",
      terminal: "authorized-cancel",
    });
    assertManagedDetailClosed(pendingCloseEvents, {
      platform: app.platformName,
      detail: pendingClose,
      cause: "close",
    });

    const pendingBack = await openPendingDetail(
      app,
      "multi-page pending back",
      markerA,
      serverAMain,
    );
    await app.nativeBack("multi-page pending back: native back");
    const pendingBackEvents = await app.captureGenerationEvents(
      "multi-page pending back: capture terminal",
    );
    assertManagedPageTerminal(pendingBackEvents, pendingBack, {
      reason: "nativeBack",
      terminal: "authorized-cancel",
    });
    assertManagedDetailClosed(pendingBackEvents, {
      platform: app.platformName,
      detail: pendingBack,
      cause: "back",
    });

    await app.control(
      "multi-page pre-confirm interruption: publish fresh B Release",
      "/e2e/jobs/create-republished-release",
      { bundleId: "$bundleB", sourceReleaseId: "$releaseB" },
      { saveResultFieldsAs: { releaseId: "releaseBPending" } },
    );
    const transitionPending = await openPendingDetail(
      app,
      "multi-page pre-confirm interruption",
      markerA,
      serverAMain,
    );
    await app.tap(
      "multi-page pre-confirm interruption: stage fresh B Release",
      "action-install-current-channel-update",
    );
    await app.assertText(
      "multi-page pre-confirm interruption: assert staged fresh B Release",
      "update-action-result",
      "$releaseBPending",
    );
    await app.control(
      "multi-page pre-confirm interruption: wait B pending",
      "/e2e/jobs/wait-for-metadata",
      { bundleId: "$bundleB", verificationPending: true },
    );
    await app.tap(
      "multi-page pre-confirm interruption: arm reconstructed detail pending",
      "action-arm-next-detail-pending",
    );
    await app.tap(
      "multi-page pre-confirm interruption: capture old host authorities",
      "action-capture-stale-authorities",
    );
    await app.tap(
      "multi-page pre-confirm interruption: accept managed transition",
      "action-reload-with-pending-detail",
    );
    const pendingTransitionEvents = await app.captureGenerationEvents(
      "multi-page pre-confirm interruption: capture accepted transition",
    );
    const pendingB = assertManagedPendingTransition(pendingTransitionEvents, {
      after: {
        bundleId: app.readScenarioString("bundleB"),
        releaseId: app.readScenarioString("releaseBPending"),
      },
      before: serverAMain,
      pending: transitionPending,
      platform: app.platformName,
    });
    await app.tap(
      "multi-page pre-confirm interruption: invoke old host authorities",
      "action-verify-stale-authorities",
    );
    assertManagedOldAuthoritiesRejected(
      await app.captureGenerationEvents(
        "multi-page pre-confirm interruption: capture stale-source rejection",
      ),
      [serverAMain, transitionPending],
    );
    await app.terminate(
      "multi-page pre-confirm interruption: terminate native process",
    );
    await app.launch(
      "multi-page pre-confirm interruption: relaunch and recover stack",
    );
    const preConfirmInterruptionEvents = await app.captureGenerationEvents(
      "multi-page pre-confirm interruption: capture recovery",
    );
    assertManagedPageTerminal(preConfirmInterruptionEvents, pendingB.pending, {
      terminal: "process-interruption",
    });
    await app.control(
      "multi-page pre-confirm interruption: prove unconfirmed not crashed",
      "/e2e/assert-lynx-page-interruption-state",
      { bundleId: "$bundleB", releaseId: "$releaseBPending" },
    );
    const recoveredServerA = assertManagedReconstructedStack(
      preConfirmInterruptionEvents,
      {
        platform: app.platformName,
        previous: { detail: pendingB.pending, main: pendingB.main },
        selection: selection(app, "bundleA", "releaseA"),
      },
    );
    if (recoveredServerA.main.processId === pendingB.pending.processId) {
      throw new Error(
        "Pre-confirm process interruption did not replace the OS process",
      );
    }
    await app.closeDetailPage(
      "multi-page pre-confirm interruption: close recovered detail",
    );

    const postConfirmPending = await openPendingDetail(
      app,
      "multi-page confirmed interruption",
      markerA,
      recoveredServerA.main,
    );
    await app.terminate(
      "multi-page confirmed interruption: terminate native process",
    );
    await app.launch(
      "multi-page confirmed interruption: relaunch and recover stack",
    );
    const confirmedInterruptionEvents = await app.captureGenerationEvents(
      "multi-page confirmed interruption: capture recovery",
    );
    assertManagedPageTerminal(confirmedInterruptionEvents, postConfirmPending, {
      terminal: "process-interruption",
    });
    await app.control(
      "multi-page confirmed interruption: prove unconfirmed not crashed",
      "/e2e/assert-lynx-page-interruption-state",
      { bundleId: "$bundleA", releaseId: "$releaseA" },
    );
    const confirmedInterruptionRecovery = assertManagedReconstructedStack(
      confirmedInterruptionEvents,
      {
        platform: app.platformName,
        previous: { detail: postConfirmPending, main: recoveredServerA.main },
        selection: { bundleId: observedBundleA, releaseId: null },
      },
    );
    if (
      confirmedInterruptionRecovery.main.processId ===
      postConfirmPending.processId
    ) {
      throw new Error(
        "Post-confirm process interruption did not replace the OS process",
      );
    }
    await app.closeDetailPage(
      "multi-page confirmed interruption: close recovered detail",
    );

    await app.control(
      "multi-page lifecycle: disable interrupted B Release",
      "/e2e/jobs/patch-release",
      { enabled: false, releaseId: "$releaseBPending" },
    );
    const fatalServerAMain = await resetAndInstallServerA(app, markerA);
    await app.tap(
      "multi-page confirmed fatal: arm next detail fatal",
      "action-arm-next-detail-fatal",
    );
    await app.tap(
      "multi-page confirmed fatal: open real detail",
      "action-open-detail-page",
    );
    const confirmedFatalEvents = await app.captureGenerationEvents(
      "multi-page confirmed fatal: capture failure and recovery",
    );
    assertManagedVerifiedFatalDetail(
      confirmedFatalEvents,
      selection(app, "bundleA", "releaseA"),
      app.platformName,
      fatalServerAMain,
    );
    assertManagedReconstructedStack(confirmedFatalEvents, {
      platform: app.platformName,
      selection: { bundleId: observedBundleA, releaseId: null },
    });
    await app.closeDetailPage("multi-page confirmed fatal: close recovery");

    const preFatalServerAMain = await resetAndInstallServerA(app, markerA);
    await app.control(
      "multi-page pre-confirm fatal: publish fresh B Release",
      "/e2e/jobs/create-republished-release",
      { bundleId: "$bundleB", sourceReleaseId: "$releaseB" },
      { saveResultFieldsAs: { releaseId: "releaseBFatal" } },
    );
    const fatalTransitionPending = await openPendingDetail(
      app,
      "multi-page pre-confirm fatal",
      markerA,
      preFatalServerAMain,
    );
    await app.tap(
      "multi-page pre-confirm fatal: stage fresh B Release",
      "action-install-current-channel-update",
    );
    await app.assertText(
      "multi-page pre-confirm fatal: assert staged fresh B Release",
      "update-action-result",
      "$releaseBFatal",
    );
    await app.control(
      "multi-page pre-confirm fatal: wait B pending",
      "/e2e/jobs/wait-for-metadata",
      { bundleId: "$bundleB", verificationPending: true },
    );
    await app.tap(
      "multi-page pre-confirm fatal: arm reconstructed detail fatal",
      "action-arm-next-detail-fatal",
    );
    await app.tap(
      "multi-page pre-confirm fatal: accept managed transition",
      "action-reload-with-pending-detail",
    );
    const preConfirmFatalEvents = await app.captureGenerationEvents(
      "multi-page pre-confirm fatal: capture transition failure and recovery",
    );
    const fatalTransitionId = assertManagedTransitionCancellation(
      preConfirmFatalEvents,
      preFatalServerAMain,
      fatalTransitionPending,
    );
    const fatalBMain = assertManagedTransition(preConfirmFatalEvents, {
      after: {
        bundleId: app.readScenarioString("bundleB"),
        releaseId: app.readScenarioString("releaseBFatal"),
      },
      before: preFatalServerAMain,
    });
    const fatalB = assertManagedVerifiedFatalDetail(
      preConfirmFatalEvents,
      {
        bundleId: app.readScenarioString("bundleB"),
        releaseId: app.readScenarioString("releaseBFatal"),
      },
      app.platformName,
      fatalBMain,
    );
    if (
      fatalB.generationId !== fatalBMain.generationId ||
      !preConfirmFatalEvents.events.some(
        (event) =>
          event.name === "generationStarted" &&
          event.details.generationId === fatalBMain.generationId &&
          event.details.transitionId === fatalTransitionId,
      )
    ) {
      throw new Error(
        "Pre-confirm detail fatal was not bound to the accepted target generation",
      );
    }
    assertManagedReconstructedStack(preConfirmFatalEvents, {
      platform: app.platformName,
      selection: selection(app, "bundleA", "releaseA"),
    });
  },
} as const;
