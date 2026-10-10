import { describe, expect, it } from "vitest";

import {
  decodeLynxIosStoredSelection,
  e2eBuiltInBundleId,
  isLynxE2eAppId,
  LYNX_E2E_BUILTIN_BUNDLE_ID,
  lynxAndroidInstalledManifestPaths,
  lynxCrashedBundleIds,
  lynxStoredExclusions,
  RN_E2E_BUILTIN_BUNDLE_ID,
  synthesizeLynxCrashHistory,
  readLynxLaunchReport,
  assertLynxStartupHang,
  assertLynxStartupInterruption,
  assertLynxAwaitingRetry,
  synthesizeLynxMetadata,
} from "./lynx-store.ts";

const receipt = {
  kind: "BUNDLE",
  releaseId: "release-stable",
  bundleId: "bundle-stable",
  catalogId: "catalog-1",
  scopeKey: "scope-1",
  generation: 4,
  catalogHash: "sha256:abcd",
  channel: "production",
  selectionContextHash: "v1:abcdabcdabcdabcd",
};

describe("Lynx E2E store projection", () => {
  it.each(["ios", "android"] as const)(
    "requires an armed native %s retry record, not synthesized crash history",
    (platform) => {
      const exclusions =
        platform === "ios"
          ? { unconfirmedReleaseIds: [], crashedBundleIds: [] }
          : { unconfirmed: [], crashed: [] };
      const record = {
        bundleId: "bundle-pending",
        retryReady: true,
        holdProcessToken: "10000000-0000-4000-8000-000000000001",
      };
      const journal = {
        ...exclusions,
        interruptedReleases: { "release-pending": record },
      };
      expect(() =>
        assertLynxAwaitingRetry(journal, platform, record.bundleId),
      ).not.toThrow();
      for (const interruptedReleases of [
        undefined,
        {},
        { "release-pending": { ...record, retryReady: false } },
        { "release-pending": { ...record, holdProcessToken: "invalid" } },
        { "release-pending": { ...record, bundleId: "different" } },
      ]) {
        expect(() =>
          assertLynxAwaitingRetry(
            { ...exclusions, interruptedReleases },
            platform,
            record.bundleId,
          ),
        ).toThrow();
      }
      const permanentlyExcluded =
        platform === "ios"
          ? { unconfirmedReleaseIds: ["release-pending"], crashedBundleIds: [] }
          : { unconfirmed: ["release-pending"], crashed: [] };
      expect(() =>
        assertLynxAwaitingRetry(
          { ...journal, ...permanentlyExcluded },
          platform,
          record.bundleId,
        ),
      ).toThrow();
    },
  );
  it.each(["ios", "android"] as const)(
    "reads %s interruption exclusions without promoting an unconfirmed Release to a crashed Bundle",
    (platform) => {
      const journal =
        platform === "ios"
          ? { unconfirmedReleaseIds: ["pending-release"], crashedBundleIds: [] }
          : { unconfirmed: ["pending-release"] };
      expect(lynxStoredExclusions(journal, platform)).toEqual({
        unconfirmedReleaseIds: ["pending-release"],
        crashedBundleIds: [],
      });
    },
  );

  it("preserves duplicate and malformed exclusions for strict assertions", () => {
    expect(
      lynxStoredExclusions(
        { unconfirmed: ["pending", "pending"], crashed: "invalid" },
        "android",
      ),
    ).toEqual({
      unconfirmedReleaseIds: ["pending", "pending"],
      crashedBundleIds: "invalid",
    });
  });

  it("recognizes the Lynx example app id", () => {
    expect(isLynxE2eAppId("com.hotupdater.lynxexample")).toBe(true);
    expect(isLynxE2eAppId("com.hotupdater.example")).toBe(false);
  });

  it("returns the full Lynx built-in identity without changing the RN contract", () => {
    expect(e2eBuiltInBundleId("com.hotupdater.lynxexample")).toBe(
      LYNX_E2E_BUILTIN_BUNDLE_ID,
    );
    expect(e2eBuiltInBundleId("com.hotupdater.example")).toBe(
      RN_E2E_BUILTIN_BUNDLE_ID,
    );
  });

  it("decodes an iOS stored receipt from base64 JSON", () => {
    const encoded = Buffer.from(JSON.stringify(receipt), "utf8").toString(
      "base64",
    );
    expect(
      decodeLynxIosStoredSelection({
        receipt: encoded,
        manifestDigest: "digest",
      }),
    ).toEqual(receipt);
  });

  it("projects Android journal files onto RN metadata shape", () => {
    const metadata = synthesizeLynxMetadata(
      {
        confirmed: receipt,
        next: {
          ...receipt,
          bundleId: "bundle-next",
          releaseId: "release-next",
        },
        crashed: ["bundle-crash"],
        highWater: {
          catalogId: "catalog-1",
          scopeKey: "scope-1",
          generation: 4,
          catalogHash: "sha256:abcd",
        },
      },
      "android",
    );
    expect(metadata).toMatchObject({
      stableBundleId: "bundle-stable",
      stagingBundleId: "bundle-next",
      verificationPending: true,
      highestSeenCatalogs: {
        "catalog-1|scope-1": {
          catalogHash: "sha256:abcd",
          generation: 4,
        },
      },
    });
  });

  it("projects a confirmed BUILTIN receipt as a null stable bundle", () => {
    const metadata = synthesizeLynxMetadata(
      {
        confirmed: {
          kind: "BUILTIN",
          releaseId: null,
          bundleId: "00000000-0000-7000-8000-000000000000",
          catalogId: "catalog-1",
          scopeKey: "scope-1",
          generation: 5,
          catalogHash: "sha256:efgh",
          channel: "production",
          selectionContextHash: "v1:abcdabcdabcdabcd",
        },
      },
      "android",
    );
    expect(metadata).toMatchObject({
      stableBundleId: null,
      stagingBundleId: "00000000-0000-7000-8000-000000000000",
      verificationPending: false,
    });
  });

  it("treats a staged BUILTIN rollback as metadata reset", () => {
    const metadata = synthesizeLynxMetadata(
      {
        next: {
          kind: "BUILTIN",
          releaseId: null,
          bundleId: "00000000-0000-7000-8000-000000000000",
          catalogId: "catalog-1",
          scopeKey: "scope-1",
          generation: 5,
          catalogHash: "sha256:efgh",
          channel: "production",
          selectionContextHash: "v1:abcdabcdabcdabcd",
        },
      },
      "android",
    );
    expect(metadata).toMatchObject({
      stableBundleId: null,
      stagingBundleId: "00000000-0000-7000-8000-000000000000",
      verificationPending: false,
      stagingSelection: { kind: "BUILTIN", releaseId: null },
    });
  });

  it("ignores a crashed next selection when projecting recovery metadata", () => {
    const metadata = synthesizeLynxMetadata(
      {
        confirmed: receipt,
        next: {
          ...receipt,
          bundleId: "bundle-crash",
          releaseId: "release-crash",
        },
        crashed: ["bundle-crash"],
      },
      "android",
    );
    expect(metadata).toMatchObject({
      stableBundleId: "bundle-stable",
      stagingBundleId: "bundle-stable",
      verificationPending: false,
    });
  });

  it("does not report an interrupted Release as a crashed Bundle", () => {
    const journal = {
      confirmed: receipt,
      unconfirmed: ["release-interrupted"],
    };
    expect(lynxCrashedBundleIds(journal, "android")).toEqual([]);
    expect(synthesizeLynxCrashHistory(journal, "android")).toMatchObject({
      bundles: [],
    });
  });

  it("projects crash history and recovery launch reports", () => {
    const journal = {
      crashedBundleIds: ["bundle-crash"],
      confirmed: {
        receipt: Buffer.from(JSON.stringify(receipt), "utf8").toString(
          "base64",
        ),
      },
    };
    expect(lynxCrashedBundleIds(journal, "ios")).toEqual(["bundle-crash"]);
    expect(synthesizeLynxCrashHistory(journal, "ios")).toMatchObject({
      bundles: [{ bundleId: "bundle-crash", crashCount: 1 }],
    });
    expect(
      lynxAndroidInstalledManifestPaths(
        "com.hotupdater.lynxexample",
        "scope-a",
        "bundle-1",
      ),
    ).toEqual([
      "/data/data/com.hotupdater.lynxexample/files/hot-updater-lynx/scopes/scope-a/artifacts/installations/bundle-1/payload/manifest.json",
      "/data/data/com.hotupdater.lynxexample/files/hot-updater-lynx/scopes/scope-a/artifacts/installations/bundle-1/manifest.json",
    ]);
  });
});

describe("Lynx native recovery evidence", () => {
  const report = {
    status: "RECOVERED",
    transitionId: "transition-1",
    fromBundleId: "bundle-hang",
    fromReleaseId: "release-hang",
    toBundleId: "bundle-stable",
    toReleaseId: "release-stable",
  };
  const screen = {
    currentBundleId: "bundle-stable",
    currentReleaseId: "release-stable",
    nativeLaunchReport: JSON.stringify(report),
  };

  it("requires a native reply for the current running Bundle and Release", () => {
    expect(readLynxLaunchReport(screen)).toEqual(report);
    expect(
      readLynxLaunchReport({ ...screen, nativeLaunchReport: null }),
    ).toBeNull();
    expect(
      readLynxLaunchReport({ ...screen, nativeLaunchReport: "invalid" }),
    ).toBeNull();
    expect(
      readLynxLaunchReport({ ...screen, currentBundleId: "bundle-new" }),
    ).toBeNull();
    expect(
      readLynxLaunchReport({ ...screen, currentReleaseId: "release-new" }),
    ).toBeNull();
    expect(
      readLynxLaunchReport({
        ...screen,
        nativeLaunchReport: JSON.stringify({
          ...report,
          transitionId: undefined,
        }),
      }),
    ).toBeNull();
  });

  it.each(["ios", "android"] as const)(
    "distinguishes an interrupted Release from a fatal Bundle on %s",
    (platform) => {
      const selection = {
        ...receipt,
        bundleId: "bundle-hang",
        releaseId: "release-hang",
      };
      const pending = {
        attemptId: "attempt-1",
        selection:
          platform === "ios"
            ? {
                receipt: Buffer.from(JSON.stringify(selection)).toString(
                  "base64",
                ),
              }
            : selection,
      };
      const exclusions = (unconfirmed: string[], crashed: string[]) =>
        platform === "ios"
          ? { unconfirmedReleaseIds: unconfirmed, crashedBundleIds: crashed }
          : { unconfirmed, crashed };
      const journal = { pending, ...exclusions([], []) };
      expect(() =>
        assertLynxStartupHang(journal, platform, "bundle-hang"),
      ).not.toThrow();
      expect(() =>
        assertLynxStartupHang(journal, platform, "wrong-bundle"),
      ).toThrow();
      expect(() =>
        assertLynxStartupHang(
          { ...journal, pending: null },
          platform,
          "bundle-hang",
        ),
      ).toThrow();
      expect(() =>
        assertLynxStartupHang(
          { ...journal, ...exclusions([], ["bundle-hang"]) },
          platform,
          "bundle-hang",
        ),
      ).toThrow();
      expect(() =>
        assertLynxStartupInterruption(
          exclusions(["release-hang"], []),
          platform,
          "bundle-hang",
          "release-hang",
        ),
      ).not.toThrow();
      expect(() =>
        assertLynxStartupInterruption(
          exclusions([], []),
          platform,
          "bundle-hang",
          "release-hang",
        ),
      ).toThrow();
      expect(() =>
        assertLynxStartupInterruption(
          exclusions(["release-hang"], ["bundle-hang"]),
          platform,
          "bundle-hang",
          "release-hang",
        ),
      ).toThrow();
    },
  );
});
