import fs from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { listSuiteNames, resolveSuiteScenarioNames } from "./scenarios.ts";

type RouteContract = {
  readonly method: "all" | "get" | "post";
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

  it("warms the app cohort update-check URL before launching OTA bundles", async () => {
    const source = await readControllerSource();

    expect(source).toContain("readCurrentE2ECohort");
    expect(source).toContain("warmCohortUpdateCheckVisibility");
    expect(source).toContain("HotUpdater_CustomCohort");
    expect(source).toContain("HotUpdaterCohort.xml");
    expect(source).toContain("cohort: cohortValue");
  });
});
