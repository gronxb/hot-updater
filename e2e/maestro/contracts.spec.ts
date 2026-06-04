import fs from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { listSuiteNames, resolveSuiteScenarioNames } from "./scenarios.ts";

type RouteContract = {
  readonly method: "all" | "delete" | "get" | "post";
  readonly path: string;
  readonly requiredError?: string;
};

const routeSourcePath = path.join(import.meta.dirname, "server", "routes.ts");
const controllerSourcePath = path.join(
  import.meta.dirname,
  "server",
  "controller.ts",
);

const defaultScenarioOrder = [
  "release-ota-recovery",
  "multi-asset-replacement",
  "bspatch-archive-to-diff-ota",
  "bspatch-consecutive-diff-ota",
  "bspatch-disabled-chain-rollback",
  "bspatch-manifest-diff-fallback",
  "runtime-channel-switch-reset",
  "numeric-cohort-rollout",
  "target-cohorts-only",
  "target-cohorts-rollout-interaction",
  "targeted-cohort-switchback",
  "force-update-auto-reload",
  "disabled-bundle-rollback-to-builtin",
  "disabled-bundle-rollback-to-previous-ota",
] as const;

const routeContracts: readonly RouteContract[] = [
  { method: "post", path: "/e2e/jobs/bootstrap" },
  { method: "get", path: "/e2e/runtime-config" },
  { method: "all", path: "/hot-updater/*" },
  { method: "all", path: "/e2e/proxy-url" },
  {
    method: "post",
    path: "/e2e/jobs/deploy-bundle",
    requiredError: "channel is required",
  },
  {
    method: "post",
    path: "/e2e/jobs/deploy-bundle",
    requiredError: "marker is required",
  },
  {
    method: "post",
    path: "/e2e/jobs/deploy-bundle",
    requiredError: "mode must be reset or crash",
  },
  {
    method: "post",
    path: "/e2e/jobs/patch-bundle",
    requiredError: "bundleId is required",
  },
  {
    method: "post",
    path: "/e2e/jobs/wait-for-metadata",
    requiredError: "bundleId and verificationPending are required",
  },
  { method: "get", path: "/e2e/jobs/:jobId" },
  { method: "delete", path: "/e2e/jobs/:jobId" },
  { method: "post", path: "/e2e/capture-built-in-bundle-id" },
  { method: "post", path: "/e2e/reset-remote-bundles" },
  { method: "post", path: "/e2e/reset-local-app-state" },
  { method: "post", path: "/e2e/cleanup" },
] as const;

async function readRouteSource(): Promise<string> {
  return fs.readFile(routeSourcePath, "utf8");
}

async function readControllerSource(): Promise<string> {
  return fs.readFile(controllerSourcePath, "utf8");
}

describe("Maestro E2E contract", () => {
  it("keeps the default scenario suite order stable", () => {
    // Given: the current Maestro scenario catalog used by dashboard sharding.
    const suiteNames = listSuiteNames();

    // When: the default suite is resolved for an E2E run.
    const scenarios = resolveSuiteScenarioNames("default");

    // Then: the provider verification order remains unchanged.
    expect(suiteNames).toEqual(["default"]);
    expect(scenarios).toEqual(defaultScenarioOrder);
  });

  it("keeps the control-server routes used by UI runners stable", async () => {
    // Given: the route source is the side-effect-free contract oracle.
    const source = await readRouteSource();

    // When: the Detox migration reuses the same control-plane endpoints.
    const routeMarkers = routeContracts.map(
      (route) => `app.${route.method}("${route.path}"`,
    );

    // Then: all required endpoints and validation messages remain present.
    for (const marker of routeMarkers) {
      expect(source).toContain(marker);
    }
    for (const route of routeContracts) {
      if (route.requiredError) {
        expect(source).toContain(route.requiredError);
      }
    }
  });

  it("runs deploy child processes with an E2E-scoped Node heap guard", async () => {
    const source = await readControllerSource();

    expect(source).toContain("HOT_UPDATER_E2E_DEPLOY_MAX_OLD_SPACE_SIZE_MB");
    expect(source).toContain("nodeOptionsForDeployChild");
    expect(source).toContain("NODE_OPTIONS: nodeOptionsForDeployChild");
  });

  it("serializes deploy child processes with a host-level E2E lock", async () => {
    const source = await readControllerSource();

    expect(source).toContain("HOT_UPDATER_E2E_DEPLOY_LOCK_DIR");
    expect(source).toContain("acquireDeployProcessLock");
    expect(source).toContain("releaseDeployProcessLock");
    expect(source).toContain("deploy process lock acquired");
    expect(source).toContain("deploy process lock waiting");
  });

  it("does not evict a just-created native artifact lock with a partial owner file", async () => {
    const source = await readControllerSource();
    const lockReaderStart = source.indexOf(
      "async function readNativeArtifactLock",
    );
    const lockReaderEnd = source.indexOf(
      "\n}\n\nfunction isProcessRunning",
      lockReaderStart,
    );
    const lockReaderSource = source.slice(lockReaderStart, lockReaderEnd);

    expect(lockReaderSource).toContain("Number.isInteger(pid)");
    expect(lockReaderSource).toContain("return null");
    expect(source).toContain("? ageMs > NATIVE_ARTIFACT_LOCK_STALE_MS");
  });

  it("reuses an explicit iOS binary without deleting shared derived data", async () => {
    const source = await readControllerSource();
    const sessionStart = source.indexOf("const session: SessionState =");
    const prepareStart = source.indexOf("async function prepareIosRelease");
    const prepareEnd = source.indexOf(
      "\n}\n\nasync function prepareAndroidRelease",
      prepareStart,
    );
    const sessionSource = source.slice(sessionStart, prepareStart);
    const prepareSource = source.slice(prepareStart, prepareEnd);

    expect(sessionSource).toContain("iosBinaryPath:");
    expect(sessionSource).toContain("HOT_UPDATER_E2E_IOS_BINARY_PATH");
    expect(prepareSource).toContain("prepareExplicitReusableIosBinary");
    expect(
      prepareSource.indexOf("prepareExplicitReusableIosBinary"),
    ).toBeLessThan(
      prepareSource.indexOf("ios derived data cache key mismatch"),
    );
  });

  it("warms the app cohort update-check URL before launching OTA bundles", async () => {
    const source = await readControllerSource();

    expect(source).toContain("readCurrentE2ECohort");
    expect(source).toContain("warmCohortUpdateCheckVisibility");
    expect(source).toContain("HotUpdater_CustomCohort");
    expect(source).toContain("HotUpdaterCohort.xml");
    expect(source).toContain("cohort: cohortValue");
  });

  it("seeds the E2E cohort before a cold app launch can request updates", async () => {
    const source = await readControllerSource();
    const resetStart = source.indexOf("async function resetLocalAppState");
    const resetEnd = source.indexOf(
      "\n}\n\nasync function assertBundlePatchBases",
      resetStart,
    );
    const prepareStart = source.indexOf("async function prepareAppLaunch");
    const prepareEnd = source.indexOf(
      "\n}\n\nasync function bootstrap",
      prepareStart,
    );
    const resetSource = source.slice(resetStart, resetEnd);
    const prepareSource = source.slice(prepareStart, prepareEnd);

    expect(source).toContain("E2E_DEFAULT_COHORT");
    expect(source).toContain("seedMissingE2ECohort");
    expect(source).toContain("defaults");
    expect(source).toContain("HotUpdaterCohort.xml");
    expect(resetSource).toContain("await seedMissingE2ECohort()");
    expect(prepareSource).toContain("await seedMissingE2ECohort()");
    expect(source).not.toContain('reason: "cohort-unavailable"');
  });

  it("prewarms the built-in release update-check key before first OTA deploy", async () => {
    const source = await readControllerSource();
    const visibilityStart = source.indexOf(
      "async function waitForUpdateCheckVisibility",
    );
    const visibilityEnd = source.indexOf(
      "\n}\n\nasync function waitForUpdateCheckVisibilityUrl",
      visibilityStart,
    );
    const currentBundleIdStart = source.indexOf(
      "function getCurrentUpdateCheckBundleId",
    );
    const currentBundleIdEnd = source.indexOf(
      "\n}\n\nfunction shouldWaitForUpdateCheckVisibility",
      currentBundleIdStart,
    );
    const nativeCacheKeyStart = source.indexOf(
      "function nativeArtifactCacheKey",
    );
    const nativeCacheKeyEnd = source.indexOf(
      "\n}\n\nfunction nativeArtifactCachePaths",
      nativeCacheKeyStart,
    );
    const visibilitySource = source.slice(visibilityStart, visibilityEnd);
    const currentBundleIdSource = source.slice(
      currentBundleIdStart,
      currentBundleIdEnd,
    );
    const nativeCacheKeySource = source.slice(
      nativeCacheKeyStart,
      nativeCacheKeyEnd,
    );

    expect(source).toContain(
      'const E2E_MIN_BUNDLE_ID = "00000000-0000-7000-8000-000000000000"',
    );
    expect(source).toContain(
      "`HOT_UPDATER_MIN_BUNDLE_ID=${E2E_MIN_BUNDLE_ID}`",
    );
    expect(source).toContain("`-PMIN_BUNDLE_ID=${E2E_MIN_BUNDLE_ID}`");
    expect(visibilitySource).toContain("const minBundleId = E2E_MIN_BUNDLE_ID");
    expect(currentBundleIdSource).toContain(
      "metadataState.stagingBundleId ?? E2E_MIN_BUNDLE_ID",
    );
    expect(nativeCacheKeySource).toContain("minBundleId: E2E_MIN_BUNDLE_ID");
  });

  it("fails provider database operations once without retry wrappers", async () => {
    const source = await readControllerSource();
    const databaseStart = source.indexOf("async function withDatabasePlugin");
    const databaseEnd = source.indexOf(
      "\n}\n\nasync function fetchBundlesPage",
      databaseStart,
    );
    const bundleListStart = source.indexOf("async function fetchBundlesPage");
    const bundleListEnd = source.indexOf(
      "\n}\n\nasync function isBundleVisible",
      bundleListStart,
    );
    const databaseSource = source.slice(databaseStart, databaseEnd);
    const bundleListSource = source.slice(bundleListStart, bundleListEnd);

    expect(source).not.toContain("PROVIDER_OPERATION_RETRY_ATTEMPTS");
    expect(source).not.toContain("PROVIDER_OPERATION_RETRY_DELAY_MS");
    expect(source).not.toContain("isTransientProviderError");
    expect(databaseSource).not.toContain("provider database operation retry");
    expect(databaseSource).not.toContain("await sleep(");
    expect(bundleListSource).not.toContain("hot-updater cli bundle list retry");
    expect(bundleListSource).not.toContain("await sleep(");
  });

  it("keeps reset channel provider-list reads sequential", async () => {
    const source = await readControllerSource();
    const bundleListStart = source.indexOf(
      "async function fetchEnabledBundlesForRemoteReset",
    );
    const bundleListEnd = source.indexOf(
      "\n}\n\nasync function patchBundle",
      bundleListStart,
    );
    const bundleListSource = source.slice(bundleListStart, bundleListEnd);

    expect(bundleListSource).toContain("for (const channel of channelList)");
    expect(bundleListSource).not.toContain("Promise.all(");
    expect(bundleListSource).not.toContain("channels.map(");
  });

  it("uses the provider bundle-list API for remote reset discovery", async () => {
    const source = await readControllerSource();
    const resetListStart = source.indexOf(
      "async function fetchEnabledBundlesForRemoteReset",
    );
    const resetListEnd = source.indexOf(
      "\n}\n\nasync function patchBundle",
      resetListStart,
    );
    const resetListSource = source.slice(resetListStart, resetListEnd);

    expect(resetListStart).toBeGreaterThan(-1);
    expect(resetListSource).toContain("fetchBundlesPage");
    expect(resetListSource).not.toContain("withDatabasePlugin");
    expect(resetListSource).not.toContain("databasePlugin.getBundles");
  });

  it("waits for the provider bundle-list API before bootstrapping", async () => {
    const source = await readControllerSource();
    const readinessUrlStart = source.indexOf(
      "function getControllerReachableProviderReadinessUrl",
    );
    const readinessUrlEnd = source.indexOf(
      "\n}\n\nfunction getAndroidControlDevicePort",
      readinessUrlStart,
    );
    const waitStart = source.indexOf(
      "async function waitForLocalProviderReady",
    );
    const waitEnd = source.indexOf("\n}\n\nfunction getUrlPort", waitStart);
    const readinessUrlsStart = source.indexOf(
      "function getLocalProviderReadinessUrls",
    );
    const readinessUrlsEnd = source.indexOf(
      "\n}\n\nfunction getAndroidControlDevicePort",
      readinessUrlsStart,
    );
    const headersStart = source.indexOf(
      "function getHotUpdaterManagementHeaders",
    );
    const headersEnd = source.indexOf(
      "\n}\n\nasync function waitForLocalProviderReady",
      headersStart,
    );
    const readinessUrlSource = source.slice(readinessUrlStart, readinessUrlEnd);
    const readinessUrlsSource = source.slice(
      readinessUrlsStart,
      readinessUrlsEnd,
    );
    const waitSource = source.slice(waitStart, waitEnd);
    const headersSource = source.slice(headersStart, headersEnd);

    expect(readinessUrlSource).toContain("/api/bundles");
    expect(readinessUrlSource).toContain('url.searchParams.set("platform"');
    expect(readinessUrlSource).toContain('url.searchParams.set("enabled"');
    expect(source).toContain("REMOTE_RESET_READINESS_LIMIT = 100");
    expect(source).toContain("PROVIDER_READY_BUNDLE_LIMITS");
    expect(readinessUrlSource).toContain("limit: number");
    expect(readinessUrlSource).toContain(
      'url.searchParams.set("limit", String(limit))',
    );
    expect(readinessUrlsSource).toContain(
      "getControllerReachableProviderReadinessUrl",
    );
    expect(readinessUrlsSource).toContain("PROVIDER_READY_BUNDLE_LIMITS");
    expect(readinessUrlsSource).toContain("getRemoteResetChannels()");
    expect(readinessUrlsSource).toContain('url.searchParams.set("channel"');
    expect(waitSource).toContain("getHotUpdaterManagementHeaders()");
    expect(waitSource).toContain("getLocalProviderReadinessUrls()");
    expect(headersSource).toContain("readHotUpdaterAuthToken()");
    expect(headersSource).toContain("session.envSourceFile");
    expect(headersSource).toContain("Authorization: `Bearer ${authToken}`");
    expect(waitSource).not.toContain("ProviderHealthUrl");
  });

  it("logs provider reset fetch causes without retrying provider operations", async () => {
    const source = await readControllerSource();
    const jobStart = source.indexOf(
      "function createJob(task: (context: JobExecutionContext) => Promise<JobResult>)",
    );
    const jobEnd = source.indexOf(
      "\n}\n\nexport function startBootstrapJob",
      jobStart,
    );
    const resetListStart = source.indexOf(
      "async function fetchEnabledBundlesForRemoteReset",
    );
    const resetListEnd = source.indexOf(
      "\n}\n\nasync function patchBundle",
      resetListStart,
    );
    const jobSource = source.slice(jobStart, jobEnd);
    const resetListSource = source.slice(resetListStart, resetListEnd);

    expect(source).toContain("formatErrorCause");
    expect(jobSource).toContain("cause: formatErrorCause(error)");
    expect(resetListSource).toContain(
      "Failed to list enabled remote bundles for reset readiness",
    );
    expect(resetListSource).toContain("cause: error");
    expect(resetListSource).not.toContain("await sleep(");
    expect(resetListSource).not.toContain("PROVIDER_OPERATION_RETRY");
  });

  it("keeps update-check timeout diagnostics inside helper scope", async () => {
    const source = await readControllerSource();
    const helperStart = source.indexOf(
      "async function waitForUpdateCheckVisibilityUrl",
    );
    const helperEnd = source.indexOf(
      "\n}\n\nfunction normalizeE2ECohort",
      helperStart,
    );
    const helperSource = source.slice(helperStart, helperEnd);

    expect(helperSource).toContain("minBundleId: args.minBundleId");
    expect(helperSource).not.toContain("\n        minBundleId,\n");
  });

  it("bounds provider update-check fetches so control jobs cannot hang forever", async () => {
    const source = await readControllerSource();
    const visibilityStart = source.indexOf(
      "async function waitForUpdateCheckVisibilityUrl",
    );
    const visibilityEnd = source.indexOf(
      "\n}\n\nfunction normalizeE2ECohort",
      visibilityStart,
    );
    const exclusionStart = source.indexOf(
      "async function waitForUpdateCheckExcludesBundle",
    );
    const exclusionEnd = source.indexOf(
      "\n}\n\nasync function updateBundle",
      exclusionStart,
    );
    const visibilitySource = source.slice(visibilityStart, visibilityEnd);
    const exclusionSource = source.slice(exclusionStart, exclusionEnd);

    expect(source).toContain("HOT_UPDATER_E2E_UPDATE_CHECK_HTTP_TIMEOUT_MS");
    expect(visibilitySource).toContain(
      "signal: fetchSignal(UPDATE_CHECK_HTTP_TIMEOUT_MS, args.signal)",
    );
    expect(visibilitySource).toContain(
      "await abortableSleep(E2E_POLL_INTERVAL_MS, args.signal)",
    );
    expect(exclusionSource).toContain(
      "signal: fetchSignal(UPDATE_CHECK_HTTP_TIMEOUT_MS, args.signal)",
    );
    expect(exclusionSource).toContain(
      "await abortableSleep(E2E_POLL_INTERVAL_MS, args.signal)",
    );
  });

  it("keeps update-check request URLs inside helper scope", async () => {
    const source = await readControllerSource();
    const helperStart = source.indexOf(
      "async function waitForUpdateCheckVisibilityUrl",
    );
    const helperEnd = source.indexOf(
      "\n}\n\nfunction normalizeE2ECohort",
      helperStart,
    );
    const helperSource = source.slice(helperStart, helperEnd);

    expect(helperSource).toContain("fetch(args.url,");
    expect(helperSource).toContain("url: args.url");
    expect(helperSource).toContain("`URL: ${args.url}`");
    expect(helperSource).not.toContain("fetch(url,");
    expect(helperSource).not.toContain("`URL: ${url}`");
  });
});
