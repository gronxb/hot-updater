import { describe, expect, it } from "vitest";

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
    const mixedProof = calls.findIndex(
      (call) => call.path === "/e2e/assert-bundle-artifact-selection",
    );
    const reload = calls.findIndex((call) => call.kind === "reload");
    expect(mixedProof).toBeGreaterThanOrEqual(0);
    expect(reload).toBeGreaterThan(mixedProof);
  });
});
