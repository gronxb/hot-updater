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
  handleComputeRemoteConfigRolloutSample,
  handleComputeRolloutSample,
  handleConfigureProxy,
  handleLaunchHeadlessTask,
  handleLaunchStartupHang,
  handleLaunchUninstrumentedApp,
  handleMismatchPatchBaseFileHash,
  handlePrepareAppLaunch,
  handleProxyRemoteAssetRequest,
  handleProxyState,
  handleProxyUpdateRequest,
  handlePublishRemoteConfig,
  handleReleaseRemoteConfigLock,
  handleResetLocalAppState,
  handleResetRemoteBundles,
  handleRollbackRemoteConfig,
  handleRuntimeConfig,
  handleSeedCrashHistory,
  handleTerminateApp,
  handleVerifyConsoleInsights,
  handleWaitForCrashRecovery,
  handleWaitForMetadata,
  handleWriteSummary,
  ProxyAssertionError,
  startAcquireRemoteConfigLockJob,
  startBootstrapJob,
  startCreateRepublishedReleaseJob,
  startDeployBundleJob,
  startEnableWidgetJob,
  startWaitForAppExitJob,
  startWaitForCrashMarkerJob,
  startPatchReleaseJob,
  startRegisterNativeBuildJob,
  startResetNativeBuildChannelJob,
  startResetRemoteBundlesJob,
  startSeedCrashedBundleFrontierJob,
  startWaitForAndroidRestartJob,
  startSetNativeCheckJob,
  startWaitForArchiveResumeJob,
  startWaitForMetadataJob,
  startWaitForNativeCheckJob,
} from "./controller.ts";
import type { AppInstance } from "./controller.ts";
import { handlePatchE2eScreenState } from "./screen-state.ts";

const app = new Hono();

const INSTANCE_ERROR = "instance must be main or widget";

/** The instance a store request reads: `main` unless the body names one. */
function parseInstance(value: unknown): AppInstance | null {
  if (value === undefined) return "main";
  return value === "main" || value === "widget" ? value : null;
}

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
    error instanceof ProxyAssertionError ? 422 : 500,
  );
});

app.post("/e2e/jobs/bootstrap", async (c) => {
  return c.json({ jobId: startBootstrapJob(await c.req.json()) });
});

app.post("/e2e/jobs/reset-remote-bundles", async (c) => {
  return c.json({ jobId: startResetRemoteBundlesJob() });
});

app.post("/e2e/jobs/register-native-build", async (c) => {
  const payload = (await c.req.json()) as { appVersion?: unknown };
  if (typeof payload.appVersion !== "string" || !payload.appVersion) {
    return c.json({ error: "appVersion is required" }, 400);
  }
  return c.json({
    jobId: startRegisterNativeBuildJob({ appVersion: payload.appVersion }),
  });
});

app.post("/e2e/jobs/reset-native-build-channel", async (c) => {
  const payload = (await c.req.json()) as { channel?: unknown };
  if (typeof payload.channel !== "string" || !payload.channel) {
    return c.json({ error: "channel is required" }, 400);
  }
  return c.json({
    jobId: startResetNativeBuildChannelJob({ channel: payload.channel }),
  });
});

app.post("/e2e/mismatch-patch-base-file-hash", async (c) => {
  const payload = (await c.req.json()) as {
    baseBundleId?: unknown;
    bundleId?: unknown;
  };
  if (
    typeof payload.baseBundleId !== "string" ||
    typeof payload.bundleId !== "string"
  ) {
    return c.json({ error: "baseBundleId and bundleId are required" }, 400);
  }
  return c.json(
    await handleMismatchPatchBaseFileHash({
      baseBundleId: payload.baseBundleId,
      bundleId: payload.bundleId,
    }),
  );
});

app.get("/e2e/runtime-config", (c) => {
  return c.json(handleRuntimeConfig());
});

app.post("/e2e/screen-state", async (c) => {
  return c.json(handlePatchE2eScreenState(await c.req.json()));
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

app.post("/e2e/jobs/acquire-remote-config-lock", (c) => {
  return c.json({ jobId: startAcquireRemoteConfigLockJob() });
});

app.post("/e2e/release-remote-config-lock", async (c) => {
  return c.json(await handleReleaseRemoteConfigLock());
});

app.post("/e2e/publish-remote-config", async (c) => {
  const payload = (await c.req.json()) as {
    template?: unknown;
    description?: unknown;
  };
  if (typeof payload.template !== "object" || payload.template === null) {
    return c.json({ error: "template is required" }, 400);
  }
  return c.json(
    await handlePublishRemoteConfig({
      template: payload.template,
      ...(typeof payload.description === "string"
        ? { description: payload.description }
        : {}),
    }),
  );
});

app.post("/e2e/rollback-remote-config", async (c) => {
  const payload = (await c.req.json()) as { version?: unknown };
  if (typeof payload.version !== "number") {
    return c.json({ error: "version is required" }, 400);
  }
  return c.json(await handleRollbackRemoteConfig({ version: payload.version }));
});

app.all("/hot-updater/*", async (c) => {
  return handleProxyUpdateRequest(c.req.raw);
});

app.all("/e2e/proxy-url/:targetId", async (c) => {
  return handleProxyRemoteAssetRequest(c.req.raw);
});

app.post("/e2e/proxy-control", async (c) => {
  const payload = (await c.req.json()) as {
    archiveAvailable?: boolean;
    archiveFailureMode?: "corrupt" | "interrupt" | "not-found" | null;
    archiveFailures?: number;
    artifactDelayMs?: number;
    artifactFailures?: number;
    catalogDelayMs?: number;
    catalogMode?: "freeze" | "live" | "replay";
    holdArtifacts?: boolean;
    replayGeneration?: number | null;
    reset?: boolean;
  };
  if (
    payload.holdArtifacts !== undefined &&
    typeof payload.holdArtifacts !== "boolean"
  ) {
    return c.json({ error: "holdArtifacts must be a boolean" }, 400);
  }
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
    payload.archiveFailureMode !== "interrupt" &&
    payload.archiveFailureMode !== "not-found"
  ) {
    return c.json(
      {
        error:
          "archiveFailureMode must be corrupt, interrupt, not-found, or null",
      },
      400,
    );
  }
  return c.json(handleConfigureProxy(payload));
});

app.post("/e2e/proxy-state", (c) => c.json(handleProxyState()));

app.post("/e2e/assert-proxy", async (c) => {
  const payload = (await c.req.json()) as {
    artifactFailuresRemaining?: number;
    artifactRequests?: number;
    catalogRequests?: number;
    maxPathCardinality?: number;
  };
  return c.json(handleAssertProxy(payload));
});

app.post("/e2e/assert-bundle-artifact-selection", async (c) => {
  const payload = (await c.req.json()) as {
    currentBundleId?: string;
    selection?: "manifest-v2";
    targetBundleId?: string;
  };
  if (
    !payload.currentBundleId ||
    !payload.targetBundleId ||
    payload.selection !== "manifest-v2"
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
      selection: payload.selection,
      targetBundleId: payload.targetBundleId,
    }),
  );
});

app.post("/e2e/assert-bundle-artifact-transfers", async (c) => {
  const payload = (await c.req.json()) as {
    archiveInterruptions?: number;
    archiveRequests?: number;
    archiveResumes?: number;
    currentBundleId?: string;
    fileRequests?: number | "changed-assets";
    filesRequests?: number;
    maxRequestsPerAsset?: number;
    minNetworkAssets?: number;
    patchRequests?: number;
    targetBundleId?: string;
    verifyAllAssetHashes?: boolean;
  };
  const counts = [
    payload.archiveRequests,
    payload.fileRequests === "changed-assets" ? 0 : payload.fileRequests,
    payload.patchRequests,
  ];
  if (
    payload.currentBundleId === "" ||
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
        payload.minNetworkAssets < 0)) ||
    [
      payload.archiveInterruptions,
      payload.archiveResumes,
      payload.filesRequests,
    ].some(
      (value) =>
        value !== undefined && (!Number.isSafeInteger(value) || value < 0),
    )
  ) {
    return c.json(
      {
        error:
          "a target bundle id and non-negative archive, file, and patch request counts are required",
      },
      400,
    );
  }
  return c.json(
    handleAssertBundleArtifactTransfers({
      archiveInterruptions: payload.archiveInterruptions,
      archiveRequests: payload.archiveRequests!,
      archiveResumes: payload.archiveResumes,
      currentBundleId: payload.currentBundleId,
      fileRequests: payload.fileRequests!,
      filesRequests: payload.filesRequests,
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
    bundleProfile?:
      | "assetHeavy"
      | "default"
      | "multiAssetReplacement"
      | "sizeAwareLargeDiff";
    channel?: string;
    signingKey?: unknown;
    disabled?: boolean;
    diffBaseBundleId?: string;
    forceUpdate?: boolean;
    instance?: unknown;
    marker?: string;
    message?: string;
    mode?: "crash" | "crash-after-content" | "hang" | "reset" | "slow-start";
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
  const deployInstance = parseInstance(payload.instance);
  if (!deployInstance) {
    return c.json({ error: INSTANCE_ERROR }, 400);
  }
  if (!payload.marker) {
    return c.json({ error: "marker is required" }, 400);
  }
  if (
    payload.mode !== "reset" &&
    payload.mode !== "crash" &&
    payload.mode !== "crash-after-content" &&
    payload.mode !== "hang" &&
    payload.mode !== "slow-start"
  ) {
    return c.json(
      {
        error:
          "mode must be reset, crash, crash-after-content, hang, or slow-start",
      },
      400,
    );
  }
  if (
    payload.bundleProfile !== undefined &&
    payload.bundleProfile !== "default" &&
    payload.bundleProfile !== "assetHeavy" &&
    payload.bundleProfile !== "multiAssetReplacement" &&
    payload.bundleProfile !== "sizeAwareLargeDiff"
  ) {
    return c.json(
      {
        error:
          "bundleProfile must be default, assetHeavy, multiAssetReplacement, or sizeAwareLargeDiff",
      },
      400,
    );
  }
  if (!payload.targetAppVersion) {
    return c.json({ error: "targetAppVersion is required" }, 400);
  }
  if (
    payload.signingKey !== undefined &&
    payload.signingKey !== "foreign" &&
    payload.signingKey !== "secret"
  ) {
    return c.json(
      { error: "signingKey must be foreign or secret when set" },
      400,
    );
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
      signingKey: payload.signingKey,
      disabled: payload.disabled,
      diffBaseBundleId: payload.diffBaseBundleId,
      forceUpdate: payload.forceUpdate,
      instance: deployInstance,
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
  return c.json(handleSeedCrashHistory(payload.bundleIds));
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

app.post("/e2e/jobs/set-native-check", async (c) => {
  const payload = (await c.req.json()) as {
    strategy?: string;
    requestTimeoutMs?: number;
    checkTimeoutMs?: number;
  };
  if (payload.strategy !== "appVersion" && payload.strategy !== "fingerprint") {
    return c.json({ error: "strategy must be appVersion or fingerprint" }, 400);
  }
  if (
    payload.requestTimeoutMs !== undefined &&
    (!Number.isSafeInteger(payload.requestTimeoutMs) ||
      payload.requestTimeoutMs <= 0)
  ) {
    return c.json(
      { error: "requestTimeoutMs must be a positive integer" },
      400,
    );
  }
  if (
    payload.checkTimeoutMs !== undefined &&
    (!Number.isSafeInteger(payload.checkTimeoutMs) ||
      payload.checkTimeoutMs <= 0)
  ) {
    return c.json({ error: "checkTimeoutMs must be a positive integer" }, 400);
  }
  return c.json({
    jobId: startSetNativeCheckJob({
      strategy: payload.strategy,
      requestTimeoutMs: payload.requestTimeoutMs,
      checkTimeoutMs: payload.checkTimeoutMs,
    }),
  });
});

app.post("/e2e/jobs/enable-widget", async (c) => {
  // The body is optional: the timeouts default to the host's.
  const payload = ((await c.req.json().catch(() => ({}))) ?? {}) as {
    requestTimeoutMs?: number;
    checkTimeoutMs?: number;
  };
  for (const value of [payload.requestTimeoutMs, payload.checkTimeoutMs]) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
      return c.json({ error: "timeouts must be positive integers" }, 400);
    }
  }
  return c.json({
    jobId: startEnableWidgetJob({
      requestTimeoutMs: payload.requestTimeoutMs,
      checkTimeoutMs: payload.checkTimeoutMs,
    }),
  });
});

app.post("/e2e/jobs/wait-for-native-check", async (c) => {
  const payload = (await c.req.json()) as {
    instance?: unknown;
    nonce?: string;
    status?: string;
  };
  const status = payload.status;
  if (
    !payload.nonce ||
    (status !== "upToDate" &&
      status !== "ready" &&
      status !== "pending" &&
      status !== "failed")
  ) {
    return c.json({ error: "nonce and a prepare status are required" }, 400);
  }
  const instance = parseInstance(payload.instance);
  if (!instance) {
    return c.json({ error: INSTANCE_ERROR }, 400);
  }
  return c.json({
    jobId: startWaitForNativeCheckJob({
      instance,
      nonce: payload.nonce,
      status,
    }),
  });
});

app.post("/e2e/jobs/wait-for-crash-marker", async (c) => {
  const payload = (await c.req.json()) as {
    bundleId?: string;
    instance?: unknown;
  };
  if (!payload.bundleId) {
    return c.json({ error: "bundleId is required" }, 400);
  }
  const instance = parseInstance(payload.instance);
  if (!instance) {
    return c.json({ error: INSTANCE_ERROR }, 400);
  }
  return c.json({
    jobId: startWaitForCrashMarkerJob({ bundleId: payload.bundleId, instance }),
  });
});

// Main's fatal after its launch monitoring: nothing restarts the app, so the
// wait proves the bundle's own crash ended it.
app.post("/e2e/jobs/wait-for-app-exit", async (c) => {
  const payload = (await c.req.json()) as { bundleId?: string };
  if (!payload.bundleId) {
    return c.json({ error: "bundleId is required" }, 400);
  }
  return c.json({
    jobId: startWaitForAppExitJob({ bundleId: payload.bundleId }),
  });
});

app.post("/e2e/jobs/wait-for-archive-resume", (c) => {
  return c.json({ jobId: startWaitForArchiveResumeJob() });
});

app.post("/e2e/jobs/wait-for-metadata", async (c) => {
  const payload = (await c.req.json()) as {
    attempts?: number;
    bundleId?: string;
    instance?: unknown;
    releaseId?: string;
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
  const instance = parseInstance(payload.instance);
  if (!instance) {
    return c.json({ error: INSTANCE_ERROR }, 400);
  }

  return c.json({
    jobId: startWaitForMetadataJob(
      payload.bundleId,
      payload.verificationPending,
      {
        attempts: payload.attempts,
        instance,
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
  };
  if (!payload.bundleId || !payload.releaseId) {
    return c.json({ error: "bundleId and releaseId are required" }, 400);
  }

  return c.json({
    jobId: startWaitForAndroidRestartJob(payload.bundleId, payload.releaseId),
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

app.post("/e2e/compute-remote-config-rollout-sample", async (c) => {
  const payload = (await c.req.json()) as {
    seed?: string;
    percent?: number;
    widenedPercent?: number;
  };
  if (
    typeof payload.seed !== "string" ||
    typeof payload.percent !== "number" ||
    typeof payload.widenedPercent !== "number" ||
    payload.widenedPercent <= payload.percent
  ) {
    return c.json(
      { error: "seed, percent, and a larger widenedPercent are required" },
      400,
    );
  }

  return c.json(
    await handleComputeRemoteConfigRolloutSample({
      seed: payload.seed,
      percent: payload.percent,
      widenedPercent: payload.widenedPercent,
    }),
  );
});

app.post("/e2e/wait-for-metadata", async (c) => {
  const payload = (await c.req.json()) as {
    bundleId?: string;
    releaseId?: string;
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
  };

  if (!payload.baseBundleId) {
    return c.json({ error: "baseBundleId is required" }, 400);
  }

  return c.json(
    await handleAssertBsdiffPatchApplied({
      assetPath: payload.assetPath || "index.ios.bundle",
      baseBundleId: payload.baseBundleId,
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
  const payload = (await c.req.json()) as {
    absentBundleIds?: unknown;
    bundleId?: string;
    instance?: unknown;
  };
  if (!payload.bundleId) {
    return c.json({ error: "bundleId is required" }, 400);
  }
  const instance = parseInstance(payload.instance);
  if (!instance) {
    return c.json({ error: INSTANCE_ERROR }, 400);
  }
  const absentBundleIds = payload.absentBundleIds ?? [];
  if (
    !Array.isArray(absentBundleIds) ||
    !absentBundleIds.every((value) => typeof value === "string" && value)
  ) {
    return c.json({ error: "absentBundleIds must be bundle IDs" }, 400);
  }

  return c.json(
    await handleAssertMetadataActive(payload.bundleId, {
      absentBundleIds,
      instance,
    }),
  );
});

app.post("/e2e/assert-metadata-reset", async (c) => {
  // Older callers post no body.
  const payload = ((await c.req.json().catch(() => ({}))) ?? {}) as {
    instance?: unknown;
  };
  const instance = parseInstance(payload.instance);
  if (!instance) {
    return c.json({ error: INSTANCE_ERROR }, 400);
  }
  return c.json(await handleAssertMetadataReset(instance));
});

app.post("/e2e/assert-launch-report", async (c) => {
  const payload = (await c.req.json()) as {
    fromBundleId?: string;
    fromReleaseId?: string;
    instance?: unknown;
    optional?: boolean;
    status?: string;
    toBundleId?: string;
    toReleaseId?: string;
  };
  if (!payload.status) {
    return c.json({ error: "status is required" }, 400);
  }
  const instance = parseInstance(payload.instance);
  if (!instance) {
    return c.json({ error: INSTANCE_ERROR }, 400);
  }

  return c.json(
    await handleAssertLaunchReport({
      fromBundleId: payload.fromBundleId,
      fromReleaseId: payload.fromReleaseId,
      instance,
      optional: payload.optional ?? false,
      status: payload.status,
      toBundleId: payload.toBundleId,
      toReleaseId: payload.toReleaseId,
    }),
  );
});

app.post("/e2e/assert-crash-history", async (c) => {
  const payload = (await c.req.json()) as {
    awaitingRetry?: boolean;
    bundleId?: string;
    instance?: unknown;
  };
  if (!payload.bundleId) {
    return c.json({ error: "bundleId is required" }, 400);
  }
  const instance = parseInstance(payload.instance);
  if (!instance) {
    return c.json({ error: INSTANCE_ERROR }, 400);
  }

  return c.json(
    await handleAssertCrashHistory(
      payload.bundleId,
      payload.awaitingRetry === true,
      instance,
    ),
  );
});

app.post("/e2e/prepare-app-launch", async (c) => {
  return c.json(await handlePrepareAppLaunch());
});

app.post("/e2e/terminate-app", async (c) => {
  return c.json(await handleTerminateApp());
});

app.post("/e2e/launch-startup-hang", async (c) => {
  const payload = (await c.req.json()) as { bundleId?: string };
  if (!payload.bundleId) return c.json({ error: "bundleId is required" }, 400);
  return c.json(await handleLaunchStartupHang(payload.bundleId));
});

app.post("/e2e/launch-headless-task", async (c) => {
  const payload = (await c.req.json()) as { bundleId?: string };
  if (!payload.bundleId) return c.json({ error: "bundleId is required" }, 400);
  return c.json(await handleLaunchHeadlessTask(payload.bundleId));
});

app.post("/e2e/launch-uninstrumented-app", async (c) => {
  return c.json(await handleLaunchUninstrumentedApp());
});

app.post("/e2e/wait-for-crash-recovery", async (c) => {
  const payload = (await c.req.json()) as {
    crashedBundleId?: string;
    instance?: unknown;
    restartApp?: unknown;
    stableBundleId?: string;
  };
  if (!payload.stableBundleId || !payload.crashedBundleId) {
    return c.json(
      { error: "stableBundleId and crashedBundleId are required" },
      400,
    );
  }
  const instance = parseInstance(payload.instance);
  if (!instance) {
    return c.json({ error: INSTANCE_ERROR }, 400);
  }

  return c.json(
    await handleWaitForCrashRecovery(
      payload.stableBundleId,
      payload.crashedBundleId,
      {
        instance,
        restartApp: payload.restartApp === true,
        signal: c.req.raw.signal,
      },
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
