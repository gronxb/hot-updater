import { Hono } from "hono";

import {
  cancelJob,
  getJob,
  handleAssertBsdiffPatchApplied,
  handleAssertBundleAssetsStored,
  handleAssertBundlePatchBases,
  handleAssertCrashHistory,
  handleAssertFirstOtaUsesArchive,
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
  handlePrepareAppLaunch,
  handleProxyRemoteAssetRequest,
  handleProxyState,
  handleProxyUpdateRequest,
  handleResetLocalAppState,
  handleResetRemoteBundles,
  handleRuntimeConfig,
  handleSeedCrashHistory,
  handleSeedLegacyMetadata,
  handleVerifyConsoleAnalytics,
  handleWaitForCrashRecovery,
  handleWaitForMetadata,
  handleWriteSummary,
  startBootstrapJob,
  startCreateRollbackReleaseJob,
  startDeployBundleJob,
  startPatchReleaseJob,
  startResetRemoteBundlesJob,
  startSeedCrashedBundleFrontierJob,
  startWaitForAndroidRestartJob,
  startWaitForMetadataJob,
} from "./controller.ts";
import { handlePatchE2eScreenState } from "./screen-state.ts";

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
  return c.json({ jobId: startBootstrapJob() });
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

app.post("/e2e/verify-console-analytics", async (c) => {
  const payload = (await c.req.json()) as {
    bundleIds?: unknown;
    sinceMs?: unknown;
  };
  if (
    !Array.isArray(payload.bundleIds) ||
    !payload.bundleIds.every((value) => typeof value === "string") ||
    typeof payload.sinceMs !== "number" ||
    !Number.isFinite(payload.sinceMs)
  ) {
    return c.json({ error: "bundleIds and sinceMs are required" }, 400);
  }
  return c.json(
    await handleVerifyConsoleAnalytics({
      bundleIds: payload.bundleIds,
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
    artifactDelayMs?: number;
    artifactFailures?: number;
    catalogDelayMs?: number;
    catalogMode?: "freeze" | "live" | "replay";
    replayGeneration?: number | null;
    reset?: boolean;
  };
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

app.post("/e2e/jobs/deploy-bundle", async (c) => {
  const payload = (await c.req.json()) as {
    bundleProfile?: "archive300mb" | "default" | "multiAssetReplacement";
    channel?: string;
    disabled?: boolean;
    diffBaseBundleId?: string;
    forceUpdate?: boolean;
    marker?: string;
    message?: string;
    mode?: "crash" | "reset";
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
  if (payload.mode !== "reset" && payload.mode !== "crash") {
    return c.json({ error: "mode must be reset or crash" }, 400);
  }
  if (
    payload.bundleProfile !== undefined &&
    payload.bundleProfile !== "default" &&
    payload.bundleProfile !== "archive300mb" &&
    payload.bundleProfile !== "multiAssetReplacement"
  ) {
    return c.json(
      {
        error:
          "bundleProfile must be default, archive300mb, or multiAssetReplacement",
      },
      400,
    );
  }
  if (!payload.targetAppVersion) {
    return c.json({ error: "targetAppVersion is required" }, 400);
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

app.post("/e2e/jobs/create-rollback-release", async (c) => {
  const payload = (await c.req.json()) as {
    sourceReleaseId?: string;
    toBundleId?: string | null;
  };
  if (!payload.sourceReleaseId || payload.toBundleId === undefined) {
    return c.json(
      { error: "sourceReleaseId and toBundleId are required" },
      400,
    );
  }
  return c.json({
    jobId: startCreateRollbackReleaseJob({
      sourceReleaseId: payload.sourceReleaseId,
      toBundleId: payload.toBundleId,
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

app.post("/e2e/assert-first-ota-uses-archive", async (c) => {
  const payload = (await c.req.json()) as { bundleId?: string };
  if (!payload.bundleId) {
    return c.json({ error: "bundleId is required" }, 400);
  }

  return c.json(await handleAssertFirstOtaUsesArchive(payload.bundleId));
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
    bundleId?: string;
    previousBundleId?: string;
  };
  if (!payload.bundleId || !payload.previousBundleId) {
    return c.json({ error: "bundleId and previousBundleId are required" }, 400);
  }

  return c.json(
    await handleAssertManifestDiffApplied({
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

app.post("/e2e/prepare-app-launch", async (c) => {
  return c.json(await handlePrepareAppLaunch());
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
