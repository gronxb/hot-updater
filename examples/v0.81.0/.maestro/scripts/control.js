function request(method, pathname, body) {
  const url = CONTROL_URL + pathname;
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

function expectOk(response, context) {
  if (!response.ok) {
    throw new Error(
      context + " failed: " + response.status + " " + response.body,
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

  if (!jobId) {
    throw new Error("job start response missing jobId");
  }

  for (let attempt = 0; attempt < 720; attempt += 1) {
    const pollResponse = request("GET", "/e2e/jobs/" + jobId);
    const job = expectOk(pollResponse, "job poll");

    if (job.status === "succeeded") {
      return job.result || {};
    }

    if (job.status === "failed") {
      throw new Error(job.error || "unknown job failure");
    }

    pause(1000);
  }

  throw new Error("timed out waiting for job " + jobId);
}

if (ACTION === "bootstrap") {
  const result = startJob("/e2e/jobs/bootstrap", {});
  output.emptyCrashHistoryText = result.emptyCrashHistoryText;
  output.initialMarker = result.initialMarker;
  output.stableMarker = result.stableMarker;
}

if (ACTION === "captureBuiltInBundleId") {
  const response = request("POST", "/e2e/capture-built-in-bundle-id", {});
  const result = expectOk(response, "capture built-in bundle id");
  output.builtInBundleId = result.builtInBundleId;
}

if (ACTION === "deploy") {
  const result = startJob("/e2e/jobs/deploy", {
    phase: PHASE,
  });

  if (PHASE === "stable") {
    output.stableBundleId = result.bundleId;
  }

  if (PHASE === "crash") {
    output.crashBundleId = result.bundleId;
  }
}

if (ACTION === "waitForMetadata") {
  const response = request("POST", "/e2e/wait-for-metadata", {
    bundleId: BUNDLE_ID,
    verificationPending: VERIFICATION_PENDING === "true",
  });
  expectOk(response, "wait for metadata");
}

if (ACTION === "captureState") {
  const response = request("POST", "/e2e/capture-state", {
    prefix: PREFIX,
  });
  expectOk(response, "capture state");
}

if (ACTION === "assertMetadataActive") {
  const response = request("POST", "/e2e/assert-metadata-active", {
    bundleId: BUNDLE_ID,
  });
  expectOk(response, "assert metadata active");
}

if (ACTION === "assertLaunchReport") {
  const response = request("POST", "/e2e/assert-launch-report", {
    crashedBundleId: CRASHED_BUNDLE_ID || undefined,
    optional: OPTIONAL === "true",
    status: STATUS,
  });
  expectOk(response, "assert launch report");
}

if (ACTION === "assertCrashHistory") {
  const response = request("POST", "/e2e/assert-crash-history", {
    bundleId: BUNDLE_ID,
  });
  expectOk(response, "assert crash history");
}

if (ACTION === "writeSummary") {
  const response = request("POST", "/e2e/write-summary", {});
  expectOk(response, "write summary");
}

if (ACTION === "cleanup") {
  const response = request("POST", "/e2e/cleanup", {});
  expectOk(response, "cleanup");
}

if (ACTION === "sleep") {
  pause(Number(SECONDS || "1") * 1000);
}
