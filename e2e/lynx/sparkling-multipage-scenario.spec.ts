import { describe, expect, it, vi } from "vitest";

import { getLynxScenarioDefinition, listLynxScenarioNames } from "./scenarios";
import {
  installAndReload,
  sparklingMultipageOtaScenario,
} from "./scenarios/sparkling-multipage-ota";

describe("shipped Sparkling multi-page orchestration", () => {
  it("registers one executable real multi-page scenario in the default suite", () => {
    expect(sparklingMultipageOtaScenario).toMatchObject({
      name: "sparkling-multipage-ota",
      run: expect.any(Function),
    });
    expect(getLynxScenarioDefinition("sparkling-multipage-ota")).toBe(
      sparklingMultipageOtaScenario,
    );
    expect(
      listLynxScenarioNames().filter(
        (name) => name === "sparkling-multipage-ota",
      ),
    ).toEqual(["sparkling-multipage-ota"]);
  });

  it("adopts server A over identical embedded bytes before explicitly recreating the generation", async () => {
    const control = vi.fn(
      async (
        _stage: string,
        path: string,
        body: { verificationPending?: boolean },
      ) => {
        if (path === "/e2e/jobs/wait-for-metadata")
          expect(body.verificationPending).toBe(false);
      },
    );
    const reloadManagedGeneration = vi.fn();
    const assertText = vi.fn();
    await installAndReload(
      { tap: vi.fn(), assertText, control, reloadManagedGeneration } as never,
      "server A",
      "marker A",
      "bundleA",
      "releaseA",
      { sameBundleAdoption: true },
    );
    expect(reloadManagedGeneration).toHaveBeenCalledOnce();
    expect(assertText).toHaveBeenCalledWith(
      "server A: assert installed Release",
      "update-action-result",
      "current-channel -> adopted ID $releaseA",
      { exactText: true },
    );
  });

  it("requires the real mixed no-archive patch receipt before native reload", async () => {
    const calls: Array<{ kind: string; path?: string; body?: unknown }> = [];
    const app = {
      tap: async () => calls.push({ kind: "tap" }),
      assertText: async () => calls.push({ kind: "assertText" }),
      control: async (_stage: string, path: string, body: unknown) =>
        calls.push({ kind: "control", path, body }),
      reloadManagedGeneration: async () => calls.push({ kind: "reload" }),
    };

    await installAndReload(
      app as never,
      "B install",
      "sparkling-multipage-b",
      "bundleB",
      "releaseB",
      {
        diffBaseBundleKey: "bundleA",
        diffPatchAssetPathKey: "patchAToB",
      },
    );

    expect(calls).toContainEqual({
      kind: "control",
      path: "/e2e/assert-bundle-artifact-selection",
      body: {
        currentBundleId: "$bundleA",
        requireArchiveAbsent: true,
        requiredPatchAssetPaths: ["main.lynx.bundle"],
        requiredRawAssetPaths: ["detail.lynx.bundle"],
        selection: "manifest-diff",
        targetBundleId: "$bundleB",
      },
    });
    expect(calls).toContainEqual({
      kind: "control",
      path: "/e2e/assert-bsdiff-patch-applied",
      body: {
        assetPath: "$patchAToB",
        baseBundleId: "$bundleA",
        bundleId: "$bundleB",
      },
    });
    expect(calls).toContainEqual({
      kind: "control",
      path: "/e2e/assert-bundle-assets-stored",
      body: {
        assetPaths: ["main.lynx.bundle", "detail.lynx.bundle"],
        bundleId: "$bundleB",
      },
    });
    expect(
      calls.filter((call) => call.path === "/e2e/jobs/wait-for-metadata"),
    ).toEqual([
      {
        kind: "control",
        path: "/e2e/jobs/wait-for-metadata",
        body: {
          bundleId: "$bundleB",
          releaseId: "$releaseB",
          relaunchLimit: 0,
          verificationPending: true,
        },
      },
      {
        kind: "control",
        path: "/e2e/jobs/wait-for-metadata",
        body: {
          bundleId: "$bundleB",
          releaseId: "$releaseB",
          relaunchLimit: 0,
          verificationPending: false,
        },
      },
    ]);
    const mixedProof = calls.findIndex(
      (call) => call.path === "/e2e/assert-bundle-artifact-selection",
    );
    const reload = calls.findIndex((call) => call.kind === "reload");
    expect(mixedProof).toBeGreaterThanOrEqual(0);
    expect(reload).toBeGreaterThan(mixedProof);
  });
});
