import { type Bundle, NIL_UUID } from "@hot-updater/core";
import { setupGetUpdateInfoTestSuite } from "@hot-updater/test-utils";
import { describe, expect, it } from "vitest";

import { getUpdateInfo } from "./getUpdateInfo";

describe("getUpdateInfo", () => {
  setupGetUpdateInfoTestSuite({
    getUpdateInfo,
  });
});

describe("getUpdateInfo - unknown built-in baseline bundle id (#1015)", () => {
  // Build-time generated baseline id reported by a fresh install (all random
  // bits are zero), taken from the issue report.
  const BASELINE_BUNDLE_ID = "019e37fe-bd30-7000-8000-000000000000";
  const NEWER_OTA_BUNDLE_ID = "019e3f00-90cc-70c9-bb2b-b7cf2acecf60";
  const OLDER_OTA_BUNDLE_ID = "019e2f00-1111-7abc-8123-456789abcdef";

  const DEFAULT_BUNDLE = {
    message: "hello",
    platform: "ios",
    gitCommitHash: null,
    fileHash: "hash",
    channel: "production",
    storageUri: "storage://my-app/bundle.zip",
    enabled: true,
    shouldForceUpdate: false,
  } as const;

  it("returns the latest OTA when the unknown baseline id has a newer enabled bundle", async () => {
    const bundles: Bundle[] = [
      {
        ...DEFAULT_BUNDLE,
        targetAppVersion: "1.2.0",
        fingerprintHash: null,
        id: NEWER_OTA_BUNDLE_ID,
      },
    ];

    const update = await getUpdateInfo(bundles, {
      appVersion: "1.2.0",
      minBundleId: BASELINE_BUNDLE_ID,
      bundleId: BASELINE_BUNDLE_ID,
      platform: "ios",
      _updateStrategy: "appVersion",
    });

    expect(update).toMatchObject({
      id: NEWER_OTA_BUNDLE_ID,
      status: "UPDATE",
    });
  });

  it("treats an unknown baseline id as the nil baseline instead of rolling back to an older bundle", async () => {
    const bundles: Bundle[] = [
      {
        ...DEFAULT_BUNDLE,
        targetAppVersion: "1.2.0",
        fingerprintHash: null,
        id: OLDER_OTA_BUNDLE_ID,
      },
    ];

    const update = await getUpdateInfo(bundles, {
      appVersion: "1.2.0",
      bundleId: BASELINE_BUNDLE_ID,
      platform: "ios",
      _updateStrategy: "appVersion",
    });

    expect(update).toMatchObject({
      id: OLDER_OTA_BUNDLE_ID,
      status: "UPDATE",
    });
  });

  it("returns null for an unknown baseline id when no bundles exist", async () => {
    const update = await getUpdateInfo([], {
      appVersion: "1.2.0",
      bundleId: BASELINE_BUNDLE_ID,
      platform: "ios",
      _updateStrategy: "appVersion",
    });

    expect(update).toBeNull();
  });

  it("keeps rollback semantics for unknown non-baseline bundle ids", async () => {
    const bundles: Bundle[] = [
      {
        ...DEFAULT_BUNDLE,
        targetAppVersion: "1.2.0",
        fingerprintHash: null,
        id: OLDER_OTA_BUNDLE_ID,
      },
    ];

    const update = await getUpdateInfo(bundles, {
      appVersion: "1.2.0",
      bundleId: "019e37fe-bd30-7abc-8123-456789abcdef", // deleted OTA bundle
      platform: "ios",
      _updateStrategy: "appVersion",
    });

    expect(update).toMatchObject({
      id: OLDER_OTA_BUNDLE_ID,
      status: "ROLLBACK",
    });
  });

  it("does not treat a baseline-shaped id as unknown when a bundle with that id exists", async () => {
    const bundles: Bundle[] = [
      {
        ...DEFAULT_BUNDLE,
        targetAppVersion: "1.2.0",
        fingerprintHash: null,
        id: BASELINE_BUNDLE_ID,
      },
    ];

    const update = await getUpdateInfo(bundles, {
      appVersion: "1.2.0",
      bundleId: BASELINE_BUNDLE_ID,
      platform: "ios",
      _updateStrategy: "appVersion",
    });

    expect(update).toBeNull();
  });

  it("returns the latest OTA for an unknown baseline id with the fingerprint strategy", async () => {
    const bundles: Bundle[] = [
      {
        ...DEFAULT_BUNDLE,
        targetAppVersion: null,
        fingerprintHash: "hash1",
        id: NEWER_OTA_BUNDLE_ID,
      },
    ];

    const update = await getUpdateInfo(bundles, {
      fingerprintHash: "hash1",
      minBundleId: BASELINE_BUNDLE_ID,
      bundleId: BASELINE_BUNDLE_ID,
      platform: "ios",
      _updateStrategy: "fingerprint",
    });

    expect(update).toMatchObject({
      id: NEWER_OTA_BUNDLE_ID,
      status: "UPDATE",
    });
  });

  it("treats an unknown baseline id as the nil baseline for the fingerprint strategy", async () => {
    const bundles: Bundle[] = [
      {
        ...DEFAULT_BUNDLE,
        targetAppVersion: null,
        fingerprintHash: "hash1",
        id: OLDER_OTA_BUNDLE_ID,
      },
    ];

    const update = await getUpdateInfo(bundles, {
      fingerprintHash: "hash1",
      bundleId: BASELINE_BUNDLE_ID,
      platform: "ios",
      _updateStrategy: "fingerprint",
    });

    expect(update).toMatchObject({
      id: OLDER_OTA_BUNDLE_ID,
      status: "UPDATE",
    });
  });

  it("keeps the nil baseline behavior unchanged", async () => {
    const update = await getUpdateInfo([], {
      appVersion: "1.2.0",
      bundleId: NIL_UUID,
      platform: "ios",
      _updateStrategy: "appVersion",
    });

    expect(update).toBeNull();
  });
});
