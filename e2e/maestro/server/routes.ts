import { Hono } from "hono";

import {
  getJob,
  handleAssertBundlePatchBases,
  handleAssertBsdiffPatchApplied,
  handleAssertCrashHistory,
  handleAssertFirstOtaUsesArchive,
  handleAssertLaunchReport,
  handleAssertManifestDiffApplied,
  handleAssertMetadataActive,
  handleAssertMetadataReset,
  handleEnsureAppForeground,
  handlePrepareAppLaunch,
  handleCaptureBuiltInBundleId,
  handleCaptureState,
  handleCleanup,
  handleComputeRolloutSample,
  handleReinstallBuiltInApp,
  handleResetRemoteBundles,
  handleWaitForCrashRecovery,
  handleWaitForMetadata,
  handleWriteSummary,
  startBootstrapJob,
  startDeployBundleJob,
  startPatchBundleJob,
} from "./controller.js";

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

app.post("/e2e/jobs/deploy-bundle", async (c) => {
  const payload = (await c.req.json()) as {
    autoPatch?: boolean;
    bundleProfile?: "archive300mb" | "default";
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
    payload.bundleProfile !== "archive300mb"
  ) {
    return c.json(
      { error: "bundleProfile must be default or archive300mb" },
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
      autoPatch: payload.autoPatch,
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
      targetAppVersion: payload.targetAppVersion,
      targetCohorts: payload.targetCohorts,
    }),
  });
});

app.post("/e2e/jobs/patch-bundle", async (c) => {
  const payload = (await c.req.json()) as {
    bundleId?: string;
    enabled?: boolean;
    rolloutCohortCount?: number | null;
    shouldForceUpdate?: boolean;
    targetCohorts?: string[];
  };

  if (!payload.bundleId) {
    return c.json({ error: "bundleId is required" }, 400);
  }

  if (
    payload.enabled === undefined &&
    payload.rolloutCohortCount === undefined &&
    payload.shouldForceUpdate === undefined &&
    payload.targetCohorts === undefined
  ) {
    return c.json(
      { error: "at least one bundle patch field is required" },
      400,
    );
  }

  return c.json({
    jobId: startPatchBundleJob({
      bundleId: payload.bundleId,
      enabled: payload.enabled,
      rolloutCohortCount: payload.rolloutCohortCount,
      shouldForceUpdate: payload.shouldForceUpdate,
      targetCohorts: payload.targetCohorts,
    }),
  });
});

app.get("/e2e/jobs/:jobId", async (c) => {
  const job = getJob(c.req.param("jobId"));
  if (!job) {
    return c.json({ error: "Job not found" }, 404);
  }

  return c.json(job);
});

app.post("/e2e/capture-built-in-bundle-id", async (c) => {
  return c.json(await handleCaptureBuiltInBundleId());
});

app.post("/e2e/compute-rollout-sample", async (c) => {
  const payload = (await c.req.json()) as { bundleId?: string };
  if (!payload.bundleId) {
    return c.json({ error: "bundleId is required" }, 400);
  }

  return c.json(await handleComputeRolloutSample(payload.bundleId));
});

app.post("/e2e/wait-for-metadata", async (c) => {
  const payload = (await c.req.json()) as {
    bundleId?: string;
    verificationPending?: boolean;
  };
  if (!payload.bundleId || typeof payload.verificationPending !== "boolean") {
    return c.json(
      { error: "bundleId and verificationPending are required" },
      400,
    );
  }

  return c.json(
    await handleWaitForMetadata(payload.bundleId, payload.verificationPending),
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

app.post("/e2e/reinstall-built-in-app", async (c) => {
  return c.json(await handleReinstallBuiltInApp());
});

app.post("/e2e/reset-remote-bundles", async (c) => {
  return c.json(await handleResetRemoteBundles());
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
    crashedBundleId?: string;
    optional?: boolean;
    status?: string;
  };
  if (!payload.status) {
    return c.json({ error: "status is required" }, 400);
  }

  return c.json(
    await handleAssertLaunchReport({
      crashedBundleId: payload.crashedBundleId,
      optional: payload.optional ?? false,
      status: payload.status,
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

app.post("/e2e/ensure-app-foreground", async (c) => {
  return c.json(await handleEnsureAppForeground());
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
