// Maestro runScript loads JavaScript files directly, so this helper stays JS.

// The first iOS bootstrap can include a full release build, pod install, and app reinstall.
// Keep the polling window long enough for that path instead of failing at 12 minutes.
const JOB_TIMEOUT_SECONDS = 1800;

function request(method, pathname, body) {
  const url = `${CONTROL_URL}${pathname}`;
  const headers = {
    "Content-Type": "application/json",
  };

  if (method === "GET") {
    return http.get(url, { headers });
  }

  return http.request(url, {
    body: body == null ? undefined : JSON.stringify(body),
    headers,
    method,
  });
}

function formatErrorBody(body) {
  if (!body) {
    return "";
  }

  try {
    const payload = json(body);
    if (payload && typeof payload === "object") {
      const lines = [];

      if (typeof payload.error === "string" && payload.error.length > 0) {
        lines.push(payload.error);
      }

      if (payload.details !== undefined) {
        lines.push(JSON.stringify(payload.details, null, 2));
      }

      if (lines.length > 0) {
        return lines.join("\n");
      }
    }
  } catch {}

  return String(body);
}

function expectOk(response, context) {
  if (!response.ok) {
    const formattedBody = formatErrorBody(response.body);
    throw new Error(
      `${context} failed: ${response.status}${formattedBody ? `\n${formattedBody}` : ""}`,
    );
  }

  return json(response.body);
}

function pause(milliseconds) {
  const endTime = Date.now() + milliseconds;
  while (Date.now() < endTime) {}
}

function startJob(pathname, body) {
  const response = request("POST", pathname, body);
  const payload = expectOk(response, "job start");
  const jobId = payload.jobId;
  const timeoutSeconds = (() => {
    if (JOB_TIMEOUT_SECONDS) {
      const parsed = Number(JOB_TIMEOUT_SECONDS);
      if (Number.isFinite(parsed) && parsed > 0) {
        return parsed;
      }
    }

    // Bootstrap can include a full clean release build on iOS.
    if (pathname === "/e2e/jobs/bootstrap") {
      return 1800;
    }

    return 720;
  })();

  if (!jobId) {
    throw new Error("job start response missing jobId");
  }

  for (let attempt = 0; attempt < JOB_TIMEOUT_SECONDS; attempt += 1) {
    const pollResponse = request("GET", `/e2e/jobs/${jobId}`);
    const job = expectOk(pollResponse, "job poll");

    if (job.status === "succeeded") {
      return job.result || {};
    }

    if (job.status === "failed") {
      throw new Error(job.error || "unknown job failure");
    }

    pause(1000);
  }

  throw new Error(
    `timed out waiting for job ${jobId} after ${JOB_TIMEOUT_SECONDS}s`,
  );
}

function maybeNumber(value) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid numeric value: ${value}`);
  }

  return parsed;
}

function maybeBoolean(value) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  throw new Error(`Invalid boolean value: ${value}`);
}

function parseCsv(value) {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function maybeCsv(value) {
  if (!value) {
    return undefined;
  }

  return parseCsv(value);
}

function assignIfPresent(key, value) {
  if (key && value !== undefined) {
    output[key] = value;
  }
}

switch (ACTION) {
  case "bootstrap": {
    const result = startJob("/e2e/jobs/bootstrap", {});
    output.emptyCrashHistoryText = result.emptyCrashHistoryText;
    output.initialMarker = result.initialMarker;
    break;
  }

  case "captureBuiltInBundleId": {
    const response = request("POST", "/e2e/capture-built-in-bundle-id", {});
    const result = expectOk(response, "capture built-in bundle id");
    output.builtInBundleId = result.builtInBundleId;
    break;
  }

  case "deployBundle": {
    const outputKey = OUTPUT_KEY || "bundleId";
    const result = startJob("/e2e/jobs/deploy-bundle", {
      bundleProfile: BUNDLE_PROFILE || undefined,
      channel: CHANNEL,
      disabled: maybeBoolean(DISABLED),
      forceUpdate: maybeBoolean(FORCE_UPDATE),
      marker: MARKER,
      message: MESSAGE || undefined,
      mode: MODE,
      rollout: maybeNumber(ROLLOUT),
      safeBundleIds: parseCsv(SAFE_BUNDLE_IDS),
      targetAppVersion: TARGET_APP_VERSION || "1.0.x",
      targetCohorts: maybeCsv(TARGET_COHORTS),
    });

    assignIfPresent(outputKey, result.bundleId);
    assignIfPresent(`${outputKey}Channel`, result.channel);
    assignIfPresent(`${outputKey}Enabled`, result.enabled);
    assignIfPresent(`${outputKey}Marker`, result.marker);
    assignIfPresent(
      `${outputKey}RolloutCohortCount`,
      result.rolloutCohortCount,
    );
    assignIfPresent(`${outputKey}ShouldForceUpdate`, result.shouldForceUpdate);
    break;
  }

  case "patchBundle": {
    const result = startJob("/e2e/jobs/patch-bundle", {
      bundleId: BUNDLE_ID,
      enabled: maybeBoolean(ENABLED),
      rolloutCohortCount: maybeNumber(ROLLOUT_COHORT_COUNT),
      shouldForceUpdate: maybeBoolean(SHOULD_FORCE_UPDATE),
      targetCohorts: maybeCsv(TARGET_COHORTS),
    });

    const prefix = OUTPUT_PREFIX || "";
    assignIfPresent(prefix && `${prefix}BundleId`, result.bundleId);
    assignIfPresent(prefix && `${prefix}Channel`, result.channel);
    assignIfPresent(prefix && `${prefix}Enabled`, result.enabled);
    assignIfPresent(
      prefix && `${prefix}RolloutCohortCount`,
      result.rolloutCohortCount,
    );
    assignIfPresent(
      prefix && `${prefix}ShouldForceUpdate`,
      result.shouldForceUpdate,
    );
    break;
  }

  case "computeRolloutSample": {
    const prefix = OUTPUT_PREFIX || "rollout";
    const response = request("POST", "/e2e/compute-rollout-sample", {
      bundleId: BUNDLE_ID,
    });
    const result = expectOk(response, "compute rollout sample");
    output[`${prefix}IncludedCohort`] = result.includedCohort;
    output[`${prefix}ExcludedCohort`] = result.excludedCohort;
    output[`${prefix}RolloutCohortCount`] = result.rolloutCohortCount;
    break;
  }

  case "waitForMetadata": {
    const response = request("POST", "/e2e/wait-for-metadata", {
      bundleId: BUNDLE_ID,
      verificationPending: VERIFICATION_PENDING === "true",
    });
    expectOk(response, "wait for metadata");
    break;
  }

  case "captureState": {
    const response = request("POST", "/e2e/capture-state", {
      prefix: PREFIX,
    });
    expectOk(response, "capture state");
    break;
  }

  case "assertMetadataActive": {
    const response = request("POST", "/e2e/assert-metadata-active", {
      bundleId: BUNDLE_ID,
    });
    expectOk(response, "assert metadata active");
    break;
  }

  case "assertMetadataReset": {
    const response = request("POST", "/e2e/assert-metadata-reset", {});
    expectOk(response, "assert metadata reset");
    break;
  }

  case "assertLaunchReport": {
    const response = request("POST", "/e2e/assert-launch-report", {
      crashedBundleId: CRASHED_BUNDLE_ID || undefined,
      optional: OPTIONAL === "true",
      status: STATUS,
    });
    expectOk(response, "assert launch report");
    break;
  }

  case "assertCrashHistory": {
    const response = request("POST", "/e2e/assert-crash-history", {
      bundleId: BUNDLE_ID,
    });
    expectOk(response, "assert crash history");
    break;
  }

  case "ensureAppForeground": {
    const response = request("POST", "/e2e/ensure-app-foreground", {});
    expectOk(response, "ensure app foreground");
    break;
  }

  case "waitForCrashRecovery": {
    const response = request("POST", "/e2e/wait-for-crash-recovery", {
      crashedBundleId: CRASHED_BUNDLE_ID,
      stableBundleId: STABLE_BUNDLE_ID,
    });
    expectOk(response, "wait for crash recovery");
    break;
  }

  case "writeSummary": {
    const response = request("POST", "/e2e/write-summary", {
      scenario: SCENARIO,
      status: STATUS,
    });
    expectOk(response, "write summary");
    break;
  }

  case "cleanup": {
    const response = request("POST", "/e2e/cleanup", {});
    expectOk(response, "cleanup");
    break;
  }

  case "sleep": {
    pause(Number(SECONDS || "1") * 1000);
    break;
  }

  default: {
    throw new Error(`Unsupported ACTION: ${ACTION}`);
  }
}
