import type { Bundle } from "@hot-updater/utils";
import { describe, expect, it } from "vitest";
import { checkForUpdate } from "./checkForUpdate";
import { NIL_UUID } from "./const";

describe("appVersion 1.0, bundleId null", async () => {
  it("should return null if no update information is available", async () => {
    const bundles: Bundle[] = [];

    const update = await checkForUpdate(bundles, {
      appVersion: "1.0",
      bundleId: NIL_UUID,
      platform: "ios",
    });
    expect(update).toBeNull();
  });

  it("should return null if no update is available when the app version is higher", async () => {
    const bundles: Bundle[] = [
      {
        platform: "ios",
        targetVersion: "1.1",
        enabled: true,
        id: "00000000-0000-0000-0000-000000000001",
        forceUpdate: false,
        file: "http://example.com/bundle.zip",
        hash: "hash",
      },
    ];

    const update = await checkForUpdate(bundles, {
      appVersion: "1.0",
      bundleId: NIL_UUID,
      platform: "ios",
    });
    expect(update).toBeNull();
  });

  it("should update if a higher bundle with semver version exists", async () => {
    const bundles: Bundle[] = [
      {
        platform: "ios",
        targetVersion: "1.x.x",
        enabled: true,
        id: "00000000-0000-0000-0000-000000000001",
        forceUpdate: false,
        file: "http://example.com/bundle.zip",
        hash: "hash",
      },
      {
        platform: "ios",
        targetVersion: "1.0",
        enabled: true,
        id: "00000000-0000-0000-0000-000000000002",
        forceUpdate: false,
        file: "http://example.com/bundle.zip",
        hash: "hash",
      },
    ];

    const update = await checkForUpdate(bundles, {
      appVersion: "1.0",
      bundleId: NIL_UUID,
      platform: "ios",
    });
    expect(update).toStrictEqual({
      id: "00000000-0000-0000-0000-000000000002",
      forceUpdate: false,
      status: "UPDATE",
      file: "http://example.com/bundle.zip",
      hash: "hash",
    });
  });

  it("should update if a higher bundle version exists and forceUpdate is set to true", async () => {
    const bundles: Bundle[] = [
      {
        platform: "ios",
        targetVersion: "1.0",
        enabled: true,
        id: "00000000-0000-0000-0000-000000000001",
        forceUpdate: true,
        file: "http://example.com/bundle.zip",
        hash: "hash",
      },
    ];
    const update = await checkForUpdate(bundles, {
      appVersion: "1.0",
      bundleId: NIL_UUID,
      platform: "ios",
    });

    expect(update).toStrictEqual({
      id: "00000000-0000-0000-0000-000000000001",
      forceUpdate: true,
      status: "UPDATE",
      file: "http://example.com/bundle.zip",
      hash: "hash",
    });
  });

  it("should update if a higher bundle version exists and forceUpdate is set to false", async () => {
    const bundles: Bundle[] = [
      {
        platform: "ios",
        targetVersion: "1.0",
        file: "http://example.com/bundle.zip",
        hash: "hash",
        enabled: true,
        id: "00000000-0000-0000-0000-000000000001",
        forceUpdate: false,
      },
    ];

    const update = await checkForUpdate(bundles, {
      appVersion: "1.0",
      bundleId: NIL_UUID,
      platform: "ios",
    });
    expect(update).toStrictEqual({
      file: "http://example.com/bundle.zip",
      hash: "hash",
      id: "00000000-0000-0000-0000-000000000001",
      forceUpdate: false,
      status: "UPDATE",
    });
  });

  it("should update even if the app version is the same and the bundle version is significantly higher", async () => {
    const bundles: Bundle[] = [
      {
        platform: "ios",
        targetVersion: "1.0",
        file: "http://example.com/bundle.zip",
        hash: "hash",
        forceUpdate: false,
        enabled: true,
        id: "5",
      },
    ];

    const update = await checkForUpdate(bundles, {
      appVersion: "1.0",
      bundleId: NIL_UUID,
      platform: "ios",
    });
    expect(update).toStrictEqual({
      id: "5",
      forceUpdate: false,
      status: "UPDATE",
      file: "http://example.com/bundle.zip",
      hash: "hash",
    });
  });

  it("should update if the latest version is not available but a previous version is available", async () => {
    const bundles: Bundle[] = [
      {
        platform: "ios",
        targetVersion: "1.0",
        file: "http://example.com/bundle.zip",
        hash: "hash",
        forceUpdate: true,
        enabled: false, // Disabled
        id: "00000000-0000-0000-0000-000000000002",
      },
      {
        platform: "ios",
        targetVersion: "1.0",
        file: "http://example.com/bundle.zip",
        hash: "hash",
        forceUpdate: false,
        enabled: true,
        id: "00000000-0000-0000-0000-000000000001",
      },
    ];

    const update = await checkForUpdate(bundles, {
      appVersion: "1.0",
      bundleId: NIL_UUID,
      platform: "ios",
    });
    expect(update).toStrictEqual({
      file: "http://example.com/bundle.zip",
      hash: "hash",
      id: "00000000-0000-0000-0000-000000000001",
      forceUpdate: false,
      status: "UPDATE",
    });
  });

  it("should not update if all updates are disabled", async () => {
    const bundles: Bundle[] = [
      {
        platform: "ios",
        targetVersion: "1.0",
        file: "http://example.com/bundle.zip",
        hash: "hash",
        forceUpdate: true,
        enabled: false, // Disabled
        id: "00000000-0000-0000-0000-000000000002",
      },
      {
        platform: "ios",
        targetVersion: "1.0",
        file: "http://example.com/bundle.zip",
        hash: "hash",
        forceUpdate: false,
        enabled: false, // Disabled
        id: "00000000-0000-0000-0000-000000000001",
      },
    ];

    const update = await checkForUpdate(bundles, {
      appVersion: "1.0",
      bundleId: NIL_UUID,
      platform: "ios",
    });
    expect(update).toBeNull();
  });

  it("should rollback to the original bundle when receiving the latest bundle but all updates are disabled", async () => {
    const bundles: Bundle[] = [
      {
        platform: "ios",
        targetVersion: "1.0",
        file: "http://example.com/bundle.zip",
        hash: "hash",
        forceUpdate: true,
        enabled: false, // Disabled
        id: "00000000-0000-0000-0000-000000000002",
      },
      {
        platform: "ios",
        targetVersion: "1.0",
        file: "http://example.com/bundle.zip",
        hash: "hash",
        forceUpdate: false,
        enabled: false, // Disabled
        id: "00000000-0000-0000-0000-000000000001",
      },
    ];

    const update = await checkForUpdate(bundles, {
      appVersion: "1.0",
      bundleId: NIL_UUID,
      platform: "ios",
    });
    expect(update).toStrictEqual(null);
  });

  it("should update if the latest version is available and the app version is the same", async () => {
    const bundles: Bundle[] = [
      {
        forceUpdate: false,
        platform: "ios",
        file: "20240722210327/build.zip",
        hash: "a5cbf59a627759a88d472c502423ff55a4f6cd1aafeed3536f6a5f6e870c2290",
        message: "",
        targetVersion: "1.0",
        id: "20240722210327",
        enabled: true,
      },
    ];

    const update = await checkForUpdate(bundles, {
      appVersion: "1.0",
      bundleId: NIL_UUID,
      platform: "ios",
    });
    expect(update).toStrictEqual({
      id: "20240722210327",
      forceUpdate: false,
      status: "UPDATE",
      file: "20240722210327/build.zip",
      hash: "a5cbf59a627759a88d472c502423ff55a4f6cd1aafeed3536f6a5f6e870c2290",
    });
  });
});

describe("appVersion 1.0, bundleId v2", async () => {
  it("should return null if no update information is available", async () => {
    const bundles: Bundle[] = [];

    const update = await checkForUpdate(bundles, {
      appVersion: "1.0",
      bundleId: "00000000-0000-0000-0000-000000000002",
      platform: "ios",
    });
    expect(update).toStrictEqual({
      file: null,
      hash: null,
      id: NIL_UUID,
      forceUpdate: true, // Cause the app to reload
      status: "ROLLBACK",
    });
  });

  it("should return null if no update is available when the app version is higher", async () => {
    const bundles: Bundle[] = [
      {
        platform: "ios",
        targetVersion: "1.0",
        file: "http://example.com/bundle.zip",
        hash: "hash",
        forceUpdate: false,
        enabled: true,
        id: "00000000-0000-0000-0000-000000000002",
      },
      {
        platform: "ios",
        targetVersion: "1.0",
        file: "http://example.com/bundle.zip",
        hash: "hash",
        forceUpdate: false,
        enabled: true,
        id: "00000000-0000-0000-0000-000000000001",
      },
    ];

    const update = await checkForUpdate(bundles, {
      appVersion: "1.0",
      bundleId: "00000000-0000-0000-0000-000000000002",
      platform: "ios",
    });
    expect(update).toBeNull();
  });

  it("should rollback if the latest bundle is deleted", async () => {
    const bundles: Bundle[] = [
      {
        platform: "ios",
        targetVersion: "1.0",
        file: "http://example.com/bundle.zip",
        hash: "hash",
        forceUpdate: false,
        enabled: true,
        id: "00000000-0000-0000-0000-000000000001",
      },
    ];

    const update = await checkForUpdate(bundles, {
      appVersion: "1.0",
      bundleId: "00000000-0000-0000-0000-000000000002",
      platform: "ios",
    });
    expect(update).toStrictEqual({
      file: "http://example.com/bundle.zip",
      hash: "hash",
      id: "00000000-0000-0000-0000-000000000001",
      forceUpdate: true,
      status: "ROLLBACK",
    });
  });

  it("should update if a higher bundle version exists and forceUpdate is set to false", async () => {
    const bundles: Bundle[] = [
      {
        platform: "ios",
        targetVersion: "1.0",
        file: "http://example.com/bundle.zip",
        hash: "hash",
        forceUpdate: false,
        enabled: true,
        id: "3",
      },
      {
        platform: "ios",
        targetVersion: "1.0",
        file: "http://example.com/bundle.zip",
        hash: "hash",
        forceUpdate: false,
        enabled: true,
        id: "00000000-0000-0000-0000-000000000002",
      },
      {
        platform: "ios",
        targetVersion: "1.0",
        file: "http://example.com/bundle.zip",
        hash: "hash",
        forceUpdate: false,
        enabled: true,
        id: "00000000-0000-0000-0000-000000000001",
      },
    ];

    const update = await checkForUpdate(bundles, {
      appVersion: "1.0",
      bundleId: "00000000-0000-0000-0000-000000000002",
      platform: "ios",
    });
    expect(update).toStrictEqual({
      file: "http://example.com/bundle.zip",
      hash: "hash",
      id: "3",
      forceUpdate: false,
      status: "UPDATE",
    });
  });

  it("should update even if the app version is the same and the bundle version is significantly higher", async () => {
    const bundles: Bundle[] = [
      {
        platform: "ios",
        targetVersion: "1.0",
        file: "http://example.com/bundle.zip",
        hash: "hash",
        forceUpdate: false,
        enabled: true,
        id: "5", // Higher than the current version
      },
      {
        platform: "ios",
        targetVersion: "1.0",
        file: "http://example.com/bundle.zip",
        hash: "hash",
        forceUpdate: false,
        enabled: true,
        id: "4",
      },
      {
        platform: "ios",
        targetVersion: "1.0",
        file: "http://example.com/bundle.zip",
        hash: "hash",
        forceUpdate: false,
        enabled: true,
        id: "3",
      },
      {
        platform: "ios",
        targetVersion: "1.0",
        file: "http://example.com/bundle.zip",
        hash: "hash",
        forceUpdate: false,
        enabled: true,
        id: "00000000-0000-0000-0000-000000000002",
      },
      {
        platform: "ios",
        targetVersion: "1.0",
        file: "http://example.com/bundle.zip",
        hash: "hash",
        forceUpdate: false,
        enabled: true,
        id: "00000000-0000-0000-0000-000000000001",
      },
    ];

    const update = await checkForUpdate(bundles, {
      appVersion: "1.0",
      bundleId: "00000000-0000-0000-0000-000000000002",
      platform: "ios",
    });
    expect(update).toStrictEqual({
      file: "http://example.com/bundle.zip",
      hash: "hash",
      id: "5",
      forceUpdate: false,
      status: "UPDATE",
    });
  });

  it("should not update if the latest version is disabled and matches the current version", async () => {
    const bundles: Bundle[] = [
      {
        platform: "ios",
        targetVersion: "1.0",
        file: "http://example.com/bundle.zip",
        hash: "hash",
        forceUpdate: true,
        enabled: false, // Disabled
        id: "3",
      },
      {
        platform: "ios",
        targetVersion: "1.0",
        file: "http://example.com/bundle.zip",
        hash: "hash",
        forceUpdate: true,
        enabled: true,
        id: "00000000-0000-0000-0000-000000000002",
      },
      {
        platform: "ios",
        targetVersion: "1.0",
        file: "http://example.com/bundle.zip",
        hash: "hash",
        forceUpdate: false,
        enabled: true,
        id: "00000000-0000-0000-0000-000000000001",
      },
    ];

    const update = await checkForUpdate(bundles, {
      appVersion: "1.0",
      bundleId: "00000000-0000-0000-0000-000000000002",
      platform: "ios",
    });
    expect(update).toBeNull();
  });

  it("should rollback to a previous version if the current version is disabled", async () => {
    const bundles: Bundle[] = [
      {
        platform: "ios",
        targetVersion: "1.0",
        file: "http://example.com/bundle.zip",
        hash: "hash",
        forceUpdate: true,
        enabled: false, // Disabled
        id: "00000000-0000-0000-0000-000000000002",
      },
      {
        platform: "ios",
        targetVersion: "1.0",
        file: "http://example.com/bundle.zip",
        hash: "hash",
        forceUpdate: false,
        enabled: true,
        id: "00000000-0000-0000-0000-000000000001",
      },
    ];

    const update = await checkForUpdate(bundles, {
      appVersion: "1.0",
      bundleId: "00000000-0000-0000-0000-000000000002",
      platform: "ios",
    });
    expect(update).toStrictEqual({
      file: "http://example.com/bundle.zip",
      hash: "hash",
      id: "00000000-0000-0000-0000-000000000001",
      forceUpdate: true, // Cause the app to reload
      status: "ROLLBACK",
    });
  });

  it("should rollback to the original bundle when receiving the latest bundle but all updates are disabled", async () => {
    const bundles: Bundle[] = [
      {
        platform: "ios",
        targetVersion: "1.0",
        file: "http://example.com/bundle.zip",
        hash: "hash",
        forceUpdate: true,
        enabled: false, // Disabled
        id: "00000000-0000-0000-0000-000000000002",
      },
      {
        platform: "ios",
        targetVersion: "1.0",
        file: "http://example.com/bundle.zip",
        hash: "hash",
        forceUpdate: false,
        enabled: false, // Disabled
        id: "00000000-0000-0000-0000-000000000001",
      },
    ];

    const update = await checkForUpdate(bundles, {
      appVersion: "1.0",
      bundleId: "00000000-0000-0000-0000-000000000002",
      platform: "ios",
    });
    expect(update).toStrictEqual({
      file: null,
      hash: null,
      id: NIL_UUID,
      forceUpdate: true, // Cause the app to reload
      status: "ROLLBACK",
    });
  });
});
