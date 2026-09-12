import { describe, expect, it } from "vitest";

import {
  decodeLynxIosStoredSelection,
  isLynxE2eAppId,
  lynxAndroidInstalledManifestPaths,
  lynxCrashedBundleIds,
  synthesizeLynxCrashHistory,
  synthesizeLynxLaunchReport,
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
  it("recognizes the Lynx example app id", () => {
    expect(isLynxE2eAppId("com.hotupdater.lynxexample")).toBe(true);
    expect(isLynxE2eAppId("com.hotupdater.example")).toBe(false);
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
    expect(
      synthesizeLynxLaunchReport({
        crashedBundleIds: ["bundle-crash"],
        confirmedBundleId: "bundle-stable",
        confirmedReleaseId: "release-stable",
        fromReleaseId: "release-crash",
        toReleaseId: "release-stable",
      }),
    ).toEqual({
      status: "RECOVERED",
      fromBundleId: "bundle-crash",
      toBundleId: "bundle-stable",
      fromReleaseId: "release-crash",
      toReleaseId: "release-stable",
    });
  });
});
