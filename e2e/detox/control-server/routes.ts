import { Hono } from "hono";

import {
  cancelJob,
  getJob,
  handleAssertBsdiffPatchApplied,
  handleAssertBundleArtifactSelection,
  handleAssertBundleArtifactTransfers,
  handleAssertBundleAssetsStored,
  handleAssertBundlePatchBases,
  handleAssertCrashHistory,
  handleAssertStartupInterruption,
  handleAssertFirstOtaUsesBuiltInManifest,
  handleAssertLaunchReport,
  handleAssertManifestDiffApplied,
  handleAssertMetadataActive,
  handleAssertMetadataReset,
  handleAssertMultipleAssetsReplaced,
  handleAssertProxy,
  handleCaptureBuiltInBundleId,
  handleCaptureState,
  handleCleanup,
  handleComputeRolloutSample,
  handleConfigureProxy,
  handleLaunchAndroidCrashApp,
  handleLaunchStartupHang,
  handleLaunchUninstrumentedApp,
  handlePrepareAppLaunch,
  handleProxyRemoteAssetRequest,
  handleProxyState,
  handleProxyUpdateRequest,
  handleResetLocalAppState,
  handleResetRemoteBundles,
  handleRuntimeConfig,
  handleLynxCrashState,
  handleSeedCrashHistory,
  handleSeedLegacyMetadata,
  handleVerifyConsoleInsights,
  handleWaitForCrashRecovery,
  handleWaitForMetadata,
  handleWriteSummary,
  startBootstrapJob,
  startCreateBundleDiffJob,
  startCreateRepublishedReleaseJob,
  startDeployBundleJob,
  startPatchReleaseJob,
  startResetRemoteBundlesJob,
  startSeedCrashedBundleFrontierJob,
  startWaitForAndroidRestartJob,
  startWaitForMetadataJob,
} from "./controller.ts";
import {
  handleEnqueuePendingE2eAction,
  readPendingE2eAction,
  takePendingE2eAction,
} from "./pending-action.ts";
import {
  handlePatchE2eScreenState,
  readE2eScreenStateSnapshot,
} from "./screen-state.ts";

const app = new Hono();

app.onError((error, c) => {
  console.error(error);

  const details =
    typeof error === "object" && error && "details" in error
      ? (error as { details?: unknown }).details
      : undefined;
  const message =
    error instanceof Error ? error.message : "Unknown E2E server error";

  return c.json(
    {
      details,
      error: message,
    },
    500,
  );
});

app.post("/e2e/jobs/bootstrap", async (c) => {
  return c.json({ jobId: startBootstrapJob(await c.req.json()) });
});

app.post("/e2e/jobs/reset-remote-bundles", async (c) => {
  return c.json({ jobId: startResetRemoteBundlesJob() });
});

app.get("/e2e/runtime-config", (c) => {
  return c.json(handleRuntimeConfig());
});

app.post("/e2e/screen-state", async (c) => {
  return c.json(handlePatchE2eScreenState(await c.req.json()));
});

app.get("/e2e/screen-state", (c) => {
  return c.json({ screenState: readE2eScreenStateSnapshot() });
});

app.post("/e2e/pending-action", async (c) => {
  return c.json(handleEnqueuePendingE2eAction(await c.req.json()));
});

app.get("/e2e/pending-action", (c) => {
  const action =
    c.req.query("take") === "1"
      ? takePendingE2eAction()
      : readPendingE2eAction();
  return c.json({ action });
});
app.delete("/e2e/pending-action", (c) => {
  return c.json({ action: takePendingE2eAction() });
});

app.post("/e2e/verify-console-insights", async (c) => {
  const payload = (await c.req.json()) as {
    sinceMs?: unknown;
  };
  if (
    typeof payload.sinceMs !== "number" ||
    !Number.isFinite(payload.sinceMs)
  ) {
    return c.json({ error: "sinceMs is required" }, 400);
  }
  return c.json(
    await handleVerifyConsoleInsights({
      sinceMs: payload.sinceMs,
    }),
  );
});

app.all("/hot-updater/*", async (c) => {
  return handleProxyUpdateRequest(c.req.raw);
});

app.all("/e2e/proxy-url", async (c) => {
  return handleProxyRemoteAssetRequest(c.req.raw);
});

app.all("/e2e/proxy-url/:targetId", async (c) => {
  return handleProxyRemoteAssetRequest(c.req.raw);
});

app.post("/e2e/proxy-control", async (c) => {
  const payload = (await c.req.json()) as {
    archiveAvailable?: boolean;
    archiveFailureMode?: "corrupt" | "not-found" | null;
    archiveFailures?: number;
    artifactDelayMs?: number;
    artifactFailures?: number;
    catalogDelayMs?: number;
    catalogMode?: "freeze" | "live" | "replay";
    changedAssetMutation?: {
      assetPath?: string;
      mode?: "corrupt" | "missing";
      remaining?: number;
    } | null;
    replayGeneration?: number | null;
    reset?: boolean;
  };
  if (
    payload.archiveAvailable !== undefined &&
    typeof payload.archiveAvailable !== "boolean"
  ) {
    return c.json({ error: "archiveAvailable must be a boolean" }, 400);
  }
  for (const value of [payload.artifactDelayMs, payload.catalogDelayMs]) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
      return c.json({ error: "proxy delays must be non-negative" }, 400);
    }
  }
  if (
    payload.artifactFailures !== undefined &&
    (!Number.isSafeInteger(payload.artifactFailures) ||
      payload.artifactFailures < 0)
  ) {
    return c.json(
      { error: "artifactFailures must be a non-negative integer" },
      400,
    );
  }
  if (
    payload.archiveFailures !== undefined &&
    (!Number.isSafeInteger(payload.archiveFailures) ||
      payload.archiveFailures < 0)
  ) {
    return c.json(
      { error: "archiveFailures must be a non-negative integer" },
      400,
    );
  }
  if (
    payload.archiveFailureMode !== undefined &&
    payload.archiveFailureMode !== null &&
    payload.archiveFailureMode !== "corrupt" &&
    payload.archiveFailureMode !== "not-found"
  ) {
    return c.json(
      { error: "archiveFailureMode must be corrupt, not-found, or null" },
      400,
    );
  }
  if (
    payload.changedAssetMutation !== undefined &&
    payload.changedAssetMutation !== null &&
    (payload.changedAssetMutation.assetPath !== "detail.lynx.bundle" ||
      (payload.changedAssetMutation.mode !== "corrupt" &&
        payload.changedAssetMutation.mode !== "missing") ||
      !Number.isSafeInteger(payload.changedAssetMutation.remaining) ||
      payload.changedAssetMutation.remaining! < 1)
  ) {
    return c.json(
      {
        error:
          "changedAssetMutation must target detail.lynx.bundle with corrupt or missing mode and a positive integer remaining",
      },
      400,
    );
  }
  const { changedAssetMutation, ...proxyOptions } = payload;
  return c.json(
    handleConfigureProxy({
      ...proxyOptions,
      ...(changedAssetMutation
        ? {
            changedAssetMutation: {
              assetPath: changedAssetMutation.assetPath!,
              mode: changedAssetMutation.mode!,
              remaining: changedAssetMutation.remaining!,
            },
          }
        : changedAssetMutation === null
          ? { changedAssetMutation: null }
          : {}),
    }),
  );
});

app.post("/e2e/proxy-state", (c) => c.json(handleProxyState()));

app.post("/e2e/assert-proxy", async (c) => {
  const payload = (await c.req.json()) as {
    artifactFailuresRemaining?: number;
    artifactRequests?: number;
    catalogRequests?: number;
    changedAssetMutationMode?: "corrupt" | "missing" | null;
    changedAssetMutationRemaining?: number;
    maxPathCardinality?: number;
  };
  return c.json(handleAssertProxy(payload));
});

app.post("/e2e/assert-bundle-artifact-selection", async (c) => {
  const payload = (await c.req.json()) as {
    currentBundleId?: string;
    selection?: "manifest-v1";
    requireArchiveAbsent?: boolean;
    requiredPatchAssetPaths?: string[];
    requiredRawAssetPaths?: string[];
    targetBundleId?: string;
  };
  if (
    !payload.currentBundleId ||
    !payload.targetBundleId ||
    payload.selection !== "manifest-v1"
  ) {
    return c.json(
      {
        error:
          "currentBundleId, targetBundleId, and a valid selection are required",
      },
      400,
    );
  }
  return c.json(
    handleAssertBundleArtifactSelection({
      currentBundleId: payload.currentBundleId,
      requireArchiveAbsent: payload.requireArchiveAbsent,
      requiredPatchAssetPaths: payload.requiredPatchAssetPaths,
      requiredRawAssetPaths: payload.requiredRawAssetPaths,
      selection: payload.selection,
      targetBundleId: payload.targetBundleId,
    }),
  );
});

app.post("/e2e/assert-bundle-artifact-transfers", async (c) => {
  const payload = (await c.req.json()) as {
    archiveRequests?: number;
    currentBundleId?: string;
    fileRequests?: number;
    maxRequestsPerAsset?: number;
    minNetworkAssets?: number;
    patchRequests?: number;
    targetBundleId?: string;
    verifyAllAssetHashes?: boolean;
  };
  const counts = [
    payload.archiveRequests,
    payload.fileRequests,
    payload.patchRequests,
  ];
  if (
    !payload.currentBundleId ||
    !payload.targetBundleId ||
    counts.some(
      (value) =>
        !Number.isSafeInteger(value) || (value !== undefined && value < 0),
    ) ||
    (payload.maxRequestsPerAsset !== undefined &&
      (!Number.isSafeInteger(payload.maxRequestsPerAsset) ||
        payload.maxRequestsPerAsset < 1)) ||
    (payload.minNetworkAssets !== undefined &&
      (!Number.isSafeInteger(payload.minNetworkAssets) ||
        payload.minNetworkAssets < 0))
  ) {
    return c.json(
      {
        error:
          "bundle ids and non-negative archive, file, and patch request counts are required",
      },
      400,
    );
  }
  return c.json(
    handleAssertBundleArtifactTransfers({
      archiveRequests: payload.archiveRequests!,
      currentBundleId: payload.currentBundleId,
      fileRequests: payload.fileRequests!,
      maxRequestsPerAsset: payload.maxRequestsPerAsset,
      minNetworkAssets: payload.minNetworkAssets,
      patchRequests: payload.patchRequests!,
      targetBundleId: payload.targetBundleId,
      verifyAllAssetHashes: payload.verifyAllAssetHashes,
    }),
  );
});

app.post("/e2e/jobs/deploy-bundle", async (c) => {
  const payload = (await c.req.json()) as {
    bundleProfile?: "default" | "multiAssetReplacement" | "sizeAwareLargeDiff";
    channel?: string;
    crossProvenance?: boolean;
    disabled?: boolean;
    diffBaseBundleId?: string;
    forceUpdate?: boolean;
    marker?: string;
    message?: string;
    mode?: "crash" | "hang" | "reset";
    patchMaxBaseBundles?: number;
    rollout?: number;
    safeBundleIds?: string[];
    strategy?: "appVersion" | "fingerprint";
    targetAppVersion?: string;
    targetCohorts?: string[];
  };

  if (!payload.channel) {
    return c.json({ error: "channel is required" }, 400);
  }
  if (!payload.marker) {
    return c.json({ error: "marker is required" }, 400);
  }
  if (
    payload.mode !== "reset" &&
    payload.mode !== "crash" &&
    payload.mode !== "hang"
  ) {
    return c.json({ error: "mode must be reset, crash, or hang" }, 400);
  }
  if (
    payload.bundleProfile !== undefined &&
    payload.bundleProfile !== "default" &&
    payload.bundleProfile !== "multiAssetReplacement" &&
    payload.bundleProfile !== "sizeAwareLargeDiff"
  ) {
    return c.json(
      {
        error:
          "bundleProfile must be default, multiAssetReplacement, or sizeAwareLargeDiff",
      },
      400,
    );
  }
  if (!payload.targetAppVersion) {
    return c.json({ error: "targetAppVersion is required" }, 400);
  }
  if (
    payload.crossProvenance !== undefined &&
    typeof payload.crossProvenance !== "boolean"
  ) {
    return c.json({ error: "crossProvenance must be a boolean" }, 400);
  }
  if (
    payload.patchMaxBaseBundles !== undefined &&
    (!Number.isInteger(payload.patchMaxBaseBundles) ||
      payload.patchMaxBaseBundles < 1 ||
      payload.patchMaxBaseBundles > 5)
  ) {
    return c.json(
      { error: "patchMaxBaseBundles must be an integer between 1 and 5" },
      400,
    );
  }

  return c.json({
    jobId: startDeployBundleJob({
      bundleProfile: payload.bundleProfile,
      channel: payload.channel,
      disabled: payload.disabled,
      diffBaseBundleId: payload.diffBaseBundleId,
      forceUpdate: payload.forceUpdate,
      marker: payload.marker,
      message: payload.message,
      mode: payload.mode,
      patchMaxBaseBundles: payload.patchMaxBaseBundles,
      rollout: payload.rollout,
      safeBundleIds: payload.safeBundleIds ?? [],
      strategy: payload.strategy,
      targetAppVersion: payload.targetAppVersion,
      targetCohorts: payload.targetCohorts,
    }),
  });
});

app.post("/e2e/jobs/create-bundle-diff", async (c) => {
  const payload = (await c.req.json()) as {
    baseBundleId?: string;
    bundleId?: string;
  };
  if (!payload.baseBundleId || !payload.bundleId) {
    return c.json({ error: "baseBundleId and bundleId are required" }, 400);
  }
  return c.json({
    jobId: startCreateBundleDiffJob({
      baseBundleId: payload.baseBundleId,
      bundleId: payload.bundleId,
    }),
  });
});

app.post("/e2e/jobs/create-republished-release", async (c) => {
  const payload = (await c.req.json()) as {
    bundleId?: string;
    sourceReleaseId?: string;
  };
  if (!payload.sourceReleaseId || !payload.bundleId) {
    return c.json({ error: "sourceReleaseId and bundleId are required" }, 400);
  }
  return c.json({
    jobId: startCreateRepublishedReleaseJob({
      bundleId: payload.bundleId,
      sourceReleaseId: payload.sourceReleaseId,
    }),
  });
});

app.post("/e2e/jobs/seed-crashed-bundle-frontier", async (c) => {
  const payload = (await c.req.json()) as {
    count?: number;
    sourceReleaseId?: string;
  };
  if (
    !payload.sourceReleaseId ||
    !Number.isSafeInteger(payload.count) ||
    payload.count! < 1 ||
    payload.count! > 10
  ) {
    return c.json(
      { error: "sourceReleaseId and count between 1 and 10 are required" },
      400,
    );
  }
  return c.json({
    jobId: startSeedCrashedBundleFrontierJob({
      count: payload.count!,
      sourceReleaseId: payload.sourceReleaseId,
    }),
  });
});

app.post("/e2e/seed-crash-history", async (c) => {
  const payload = (await c.req.json()) as { bundleIds?: unknown };
  if (
    !Array.isArray(payload.bundleIds) ||
    !payload.bundleIds.every((value) => typeof value === "string")
  ) {
    return c.json({ error: "bundleIds must be a string array" }, 400);
  }
  return c.json(await handleSeedCrashHistory(payload.bundleIds));
});

app.post("/e2e/seed-legacy-metadata", async (c) => {
  return c.json(handleSeedLegacyMetadata());
});

app.post("/e2e/jobs/patch-release", async (c) => {
  const payload = (await c.req.json()) as {
    releaseId?: string;
    enabled?: boolean;
    rolloutCohortCount?: number | null;
    shouldForceUpdate?: boolean;
    targetCohorts?: string[];
  };

  if (!payload.releaseId) {
    return c.json({ error: "releaseId is required" }, 400);
  }

  if (
    payload.enabled === undefined &&
    payload.rolloutCohortCount === undefined &&
    payload.shouldForceUpdate === undefined &&
    payload.targetCohorts === undefined
  ) {
    return c.json(
      { error: "at least one Release policy field is required" },
      400,
    );
  }

  return c.json({
    jobId: startPatchReleaseJob({
      releaseId: payload.releaseId,
      enabled: payload.enabled,
      rolloutCohortCount: payload.rolloutCohortCount,
      shouldForceUpdate: payload.shouldForceUpdate,
      targetCohorts: payload.targetCohorts,
    }),
  });
});

app.post("/e2e/jobs/wait-for-metadata", async (c) => {
  const payload = (await c.req.json()) as {
    attempts?: number;
    bundleId?: string;
    releaseId?: string | null;
    recoveredStableBundleId?: string;
    relaunchLimit?: number;
    verificationPending?: boolean;
  };
  if (!payload.bundleId || typeof payload.verificationPending !== "boolean") {
    return c.json(
      { error: "bundleId and verificationPending are required" },
      400,
    );
  }

  return c.json({
    jobId: startWaitForMetadataJob(
      payload.bundleId,
      payload.verificationPending,
      {
        attempts: payload.attempts,
        releaseId: payload.releaseId,
        recoveredStableBundleId: payload.recoveredStableBundleId,
        relaunchLimit: payload.relaunchLimit,
      },
    ),
  });
});

app.post("/e2e/jobs/wait-for-android-restart", async (c) => {
  const payload = (await c.req.json()) as {
    bundleId?: string;
    releaseId?: string;
    runtimeScenarioMarker?: string;
  };
  if (!payload.bundleId || !payload.releaseId) {
    return c.json({ error: "bundleId and releaseId are required" }, 400);
  }

  return c.json({
    jobId: startWaitForAndroidRestartJob(
      payload.bundleId,
      payload.releaseId,
      payload.runtimeScenarioMarker,
    ),
  });
});

app.get("/e2e/jobs/:jobId", async (c) => {
  const job = getJob(c.req.param("jobId"));
  if (!job) {
    return c.json({ error: "Job not found" }, 404);
  }

  return c.json(job);
});

app.delete("/e2e/jobs/:jobId", async (c) => {
  const job = cancelJob(c.req.param("jobId"));
  if (!job) {
    return c.json({ error: "Job not found" }, 404);
  }

  return c.json(job);
});

app.post("/e2e/capture-built-in-bundle-id", async (c) => {
  return c.json(await handleCaptureBuiltInBundleId());
});

app.post("/e2e/compute-rollout-sample", async (c) => {
  const payload = (await c.req.json()) as { releaseId?: string };
  if (!payload.releaseId) {
    return c.json({ error: "releaseId is required" }, 400);
  }

  return c.json(await handleComputeRolloutSample(payload.releaseId));
});

app.post("/e2e/wait-for-metadata", async (c) => {
  const payload = (await c.req.json()) as {
    bundleId?: string;
    releaseId?: string | null;
    verificationPending?: boolean;
  };
  if (!payload.bundleId || typeof payload.verificationPending !== "boolean") {
    return c.json(
      { error: "bundleId and verificationPending are required" },
      400,
    );
  }

  return c.json(
    await handleWaitForMetadata(payload.bundleId, payload.verificationPending, {
      releaseId: payload.releaseId,
    }),
  );
});

app.post("/e2e/assert-bsdiff-patch-applied", async (c) => {
  const payload = (await c.req.json()) as {
    assetPath?: string;
    baseBundleId?: string;
    bundleId?: string;
  };

  if (!payload.baseBundleId) {
    return c.json({ error: "baseBundleId is required" }, 400);
  }

  return c.json(
    await handleAssertBsdiffPatchApplied({
      assetPath: payload.assetPath || "index.ios.bundle",
      baseBundleId: payload.baseBundleId,
      bundleId: payload.bundleId,
    }),
  );
});

app.post("/e2e/assert-first-ota-uses-built-in-manifest", async (c) => {
  const payload = (await c.req.json()) as { bundleId?: string };
  if (!payload.bundleId) {
    return c.json({ error: "bundleId is required" }, 400);
  }

  return c.json(
    await handleAssertFirstOtaUsesBuiltInManifest(payload.bundleId),
  );
});

app.post("/e2e/reset-remote-bundles", async (c) => {
  return c.json(await handleResetRemoteBundles());
});

app.post("/e2e/reset-local-app-state", async (c) => {
  return c.json(await handleResetLocalAppState());
});

app.post("/e2e/capture-state", async (c) => {
  const payload = (await c.req.json()) as { prefix?: string };
  if (!payload.prefix) {
    return c.json({ error: "prefix is required" }, 400);
  }

  return c.json(await handleCaptureState(payload.prefix));
});

app.post("/e2e/assert-bundle-patch-bases", async (c) => {
  const payload = (await c.req.json()) as {
    absentBaseBundleIds?: string[];
    bundleId?: string;
    expectedBaseBundleIds?: string[];
  };
  if (!payload.bundleId) {
    return c.json({ error: "bundleId is required" }, 400);
  }

  return c.json(
    await handleAssertBundlePatchBases({
      absentBaseBundleIds: payload.absentBaseBundleIds,
      bundleId: payload.bundleId,
      expectedBaseBundleIds: payload.expectedBaseBundleIds,
    }),
  );
});

app.post("/e2e/assert-manifest-diff-applied", async (c) => {
  const payload = (await c.req.json()) as {
    allowBsdiff?: boolean;
    bundleId?: string;
    previousBundleId?: string;
  };
  if (!payload.bundleId || !payload.previousBundleId) {
    return c.json({ error: "bundleId and previousBundleId are required" }, 400);
  }

  return c.json(
    await handleAssertManifestDiffApplied({
      allowBsdiff: payload.allowBsdiff,
      bundleId: payload.bundleId,
      previousBundleId: payload.previousBundleId,
      signal: c.req.raw.signal,
    }),
  );
});

app.post("/e2e/assert-bundle-assets-stored", async (c) => {
  const payload = (await c.req.json()) as {
    assetPaths?: string[];
    bundleId?: string;
  };
  if (!payload.bundleId || !payload.assetPaths?.length) {
    return c.json({ error: "bundleId and assetPaths are required" }, 400);
  }

  return c.json(
    await handleAssertBundleAssetsStored({
      assetPaths: payload.assetPaths,
      bundleId: payload.bundleId,
    }),
  );
});

app.post("/e2e/assert-multiple-assets-replaced", async (c) => {
  const payload = (await c.req.json()) as {
    assetPaths?: string[];
    bundleId?: string;
    previousBundleId?: string;
  };
  if (
    !payload.bundleId ||
    !payload.previousBundleId ||
    !payload.assetPaths?.length
  ) {
    return c.json(
      { error: "bundleId, previousBundleId, and assetPaths are required" },
      400,
    );
  }

  return c.json(
    await handleAssertMultipleAssetsReplaced({
      assetPaths: payload.assetPaths,
      bundleId: payload.bundleId,
      previousBundleId: payload.previousBundleId,
    }),
  );
});

app.post("/e2e/assert-metadata-active", async (c) => {
  const payload = (await c.req.json()) as { bundleId?: string };
  if (!payload.bundleId) {
    return c.json({ error: "bundleId is required" }, 400);
  }

  return c.json(await handleAssertMetadataActive(payload.bundleId));
});

app.post("/e2e/assert-metadata-reset", async (c) => {
  return c.json(await handleAssertMetadataReset());
});

app.post("/e2e/assert-launch-report", async (c) => {
  const payload = (await c.req.json()) as {
    fromBundleId?: string;
    fromReleaseId?: string;
    optional?: boolean;
    status?: string;
    toBundleId?: string;
    toReleaseId?: string;
  };
  if (!payload.status) {
    return c.json({ error: "status is required" }, 400);
  }

  return c.json(
    await handleAssertLaunchReport({
      fromBundleId: payload.fromBundleId,
      fromReleaseId: payload.fromReleaseId,
      optional: payload.optional ?? false,
      status: payload.status,
      toBundleId: payload.toBundleId,
      toReleaseId: payload.toReleaseId,
    }),
  );
});

app.post("/e2e/assert-crash-history", async (c) => {
  const payload = (await c.req.json()) as { bundleId?: string };
  if (!payload.bundleId) {
    return c.json({ error: "bundleId is required" }, 400);
  }

  return c.json(await handleAssertCrashHistory(payload.bundleId));
});

app.post("/e2e/assert-startup-interruption", async (c) => {
  const payload = (await c.req.json()) as {
    bundleId?: string;
    releaseId?: string;
  };
  if (!payload.bundleId || !payload.releaseId) {
    return c.json({ error: "bundleId and releaseId are required" }, 400);
  }
  return c.json(
    await handleAssertStartupInterruption(payload.bundleId, payload.releaseId),
  );
});

app.post("/e2e/lynx-crash-state", (c) => c.json(handleLynxCrashState()));

app.post("/e2e/prepare-app-launch", async (c) => {
  return c.json(await handlePrepareAppLaunch(await c.req.json()));
});

app.post("/e2e/launch-startup-hang", async (c) => {
  const payload = (await c.req.json()) as { bundleId?: string };
  if (!payload.bundleId) return c.json({ error: "bundleId is required" }, 400);
  return c.json(await handleLaunchStartupHang(payload.bundleId));
});

app.post("/e2e/launch-uninstrumented-app", async (c) => {
  return c.json(await handleLaunchUninstrumentedApp());
});

app.post("/e2e/launch-android-crash-app", async (c) => {
  return c.json(await handleLaunchAndroidCrashApp());
});

app.post("/e2e/wait-for-crash-recovery", async (c) => {
  const payload = (await c.req.json()) as {
    crashedBundleId?: string;
    stableBundleId?: string;
  };
  if (!payload.stableBundleId || !payload.crashedBundleId) {
    return c.json(
      { error: "stableBundleId and crashedBundleId are required" },
      400,
    );
  }

  return c.json(
    await handleWaitForCrashRecovery(
      payload.stableBundleId,
      payload.crashedBundleId,
      { signal: c.req.raw.signal },
    ),
  );
});

app.post("/e2e/write-summary", async (c) => {
  const payload = (await c.req.json()) as {
    scenario?: string;
    status?: string;
  };
  if (!payload.scenario || !payload.status) {
    return c.json({ error: "scenario and status are required" }, 400);
  }

  return c.json(
    await handleWriteSummary(payload as { scenario: string; status: string }),
  );
});

app.post("/e2e/cleanup", async (c) => {
  return c.json(await handleCleanup());
});

export default app;
