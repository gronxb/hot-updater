import { expect, it } from "vitest";
import type { Bundle, GetBundlesArgs, UpdateInfo } from "../types";
import { NIL_UUID } from "../uuid";

const DEFAULT_BUNDLE = {
  fileUrl: "http://example.com/bundle.zip",
  fileHash: "hash",
  platform: "ios",
  gitCommitHash: null,
  message: null,
} as const;

export const setupGetUpdateInfoTestSuite = ({
  getUpdateInfo,
}: {
  getUpdateInfo: (
    bundles: Bundle[],
    options: GetBundlesArgs,
  ) => Promise<UpdateInfo | null>;
}) => {
  it("applies an update when a '*' bundle is available", async () => {
    const bundles: Bundle[] = [
      {
        ...DEFAULT_BUNDLE,
        targetAppVersion: "*",
        shouldForceUpdate: false,
        enabled: true,
        id: "00000000-0000-0000-0000-000000000001",
      },
    ];

    const update = await getUpdateInfo(bundles, {
      appVersion: "1.0",
      bundleId: NIL_UUID,
      platform: "ios",
    });

    expect(update).toStrictEqual({
      id: "00000000-0000-0000-0000-000000000001",
      fileUrl: "http://example.com/bundle.zip",
      fileHash: "hash",
      shouldForceUpdate: false,
      status: "UPDATE",
    });
  });

  it("returns null when no bundles are provided", async () => {
    const bundles: Bundle[] = [];

    const update = await getUpdateInfo(bundles, {
      appVersion: "1.0",
      bundleId: NIL_UUID,
      platform: "ios",
    });
    expect(update).toBeNull();
  });

  it("returns null when the app version does not qualify for the available higher version", async () => {
    const bundles: Bundle[] = [
      {
        ...DEFAULT_BUNDLE,
        targetAppVersion: "1.1",
        enabled: true,
        id: "00000000-0000-0000-0000-000000000001",
        shouldForceUpdate: false,
      },
    ];

    const update = await getUpdateInfo(bundles, {
      appVersion: "1.0",
      bundleId: NIL_UUID,
      platform: "ios",
    });
    expect(update).toBeNull();
  });

  it("applies an update when a higher semver-compatible bundle is available", async () => {
    const bundles: Bundle[] = [
      {
        ...DEFAULT_BUNDLE,
        targetAppVersion: "1.x.x",
        enabled: true,
        id: "00000000-0000-0000-0000-000000000001",
        shouldForceUpdate: false,
      },
      {
        ...DEFAULT_BUNDLE,
        targetAppVersion: "1.0",
        enabled: true,
        id: "00000000-0000-0000-0000-000000000002",
        shouldForceUpdate: false,
      },
    ];

    const update = await getUpdateInfo(bundles, {
      appVersion: "1.0",
      bundleId: NIL_UUID,
      platform: "ios",
    });
    expect(update).toStrictEqual({
      id: "00000000-0000-0000-0000-000000000002",
      shouldForceUpdate: false,
      status: "UPDATE",
      fileUrl: "http://example.com/bundle.zip",
      fileHash: "hash",
    });
  });

  it("applies an update if shouldForceUpdate is true for a matching version", async () => {
    const bundles: Bundle[] = [
      {
        ...DEFAULT_BUNDLE,
        targetAppVersion: "1.0",
        enabled: true,
        id: "00000000-0000-0000-0000-000000000001",
        shouldForceUpdate: true,
      },
    ];
    const update = await getUpdateInfo(bundles, {
      appVersion: "1.0",
      bundleId: NIL_UUID,
      platform: "ios",
    });

    expect(update).toStrictEqual({
      id: "00000000-0000-0000-0000-000000000001",
      shouldForceUpdate: true,
      status: "UPDATE",
      fileUrl: "http://example.com/bundle.zip",
      fileHash: "hash",
    });
  });

  it("applies an update for a matching version even if shouldForceUpdate is false", async () => {
    const bundles: Bundle[] = [
      {
        ...DEFAULT_BUNDLE,
        targetAppVersion: "1.0",
        enabled: true,
        id: "00000000-0000-0000-0000-000000000001",
        shouldForceUpdate: false,
      },
    ];

    const update = await getUpdateInfo(bundles, {
      appVersion: "1.0",
      bundleId: NIL_UUID,
      platform: "ios",
    });
    expect(update).toStrictEqual({
      id: "00000000-0000-0000-0000-000000000001",
      shouldForceUpdate: false,
      status: "UPDATE",
      fileUrl: "http://example.com/bundle.zip",
      fileHash: "hash",
    });
  });

  it("applies an update when the app version is the same but the bundle is still considered higher", async () => {
    const bundles: Bundle[] = [
      {
        ...DEFAULT_BUNDLE,
        targetAppVersion: "1.0",
        shouldForceUpdate: false,
        enabled: true,
        id: "00000000-0000-0000-0000-000000000005",
      },
    ];

    const update = await getUpdateInfo(bundles, {
      appVersion: "1.0",
      bundleId: NIL_UUID,
      platform: "ios",
    });
    expect(update).toStrictEqual({
      id: "00000000-0000-0000-0000-000000000005",
      shouldForceUpdate: false,
      fileUrl: "http://example.com/bundle.zip",
      fileHash: "hash",
      status: "UPDATE",
    });
  });

  it("falls back to an older enabled bundle when the latest is disabled", async () => {
    const bundles: Bundle[] = [
      {
        ...DEFAULT_BUNDLE,
        targetAppVersion: "1.0",
        shouldForceUpdate: true,
        enabled: false, // Disabled
        id: "00000000-0000-0000-0000-000000000002",
      },
      {
        ...DEFAULT_BUNDLE,
        targetAppVersion: "1.0",
        shouldForceUpdate: false,
        enabled: true,
        id: "00000000-0000-0000-0000-000000000001",
      },
    ];

    const update = await getUpdateInfo(bundles, {
      appVersion: "1.0",
      bundleId: NIL_UUID,
      platform: "ios",
    });
    expect(update).toStrictEqual({
      fileUrl: "http://example.com/bundle.zip",
      fileHash: "hash",
      id: "00000000-0000-0000-0000-000000000001",
      shouldForceUpdate: false,
      status: "UPDATE",
    });
  });

  it("returns null if all bundles are disabled", async () => {
    const bundles: Bundle[] = [
      {
        ...DEFAULT_BUNDLE,
        targetAppVersion: "1.0",
        shouldForceUpdate: true,
        enabled: false, // Disabled
        id: "00000000-0000-0000-0000-000000000002",
      },
      {
        ...DEFAULT_BUNDLE,
        targetAppVersion: "1.0",
        shouldForceUpdate: false,
        enabled: false, // Disabled
        id: "00000000-0000-0000-0000-000000000001",
      },
    ];

    const update = await getUpdateInfo(bundles, {
      appVersion: "1.0",
      bundleId: NIL_UUID,
      platform: "ios",
    });
    expect(update).toBeNull();
  });

  it("triggers a rollback if the latest bundle is disabled and no other updates are enabled", async () => {
    const bundles: Bundle[] = [
      {
        ...DEFAULT_BUNDLE,
        targetAppVersion: "1.0",
        shouldForceUpdate: true,
        enabled: false, // Disabled
        id: "00000000-0000-0000-0000-000000000002",
      },
      {
        ...DEFAULT_BUNDLE,
        targetAppVersion: "1.0",
        shouldForceUpdate: false,
        enabled: false, // Disabled
        id: "00000000-0000-0000-0000-000000000001",
      },
    ];

    const update = await getUpdateInfo(bundles, {
      appVersion: "1.0",
      bundleId: NIL_UUID,
      platform: "ios",
    });
    expect(update).toStrictEqual(null);
  });

  it("applies an update when a same-version bundle is available and enabled", async () => {
    const bundles: Bundle[] = [
      {
        ...DEFAULT_BUNDLE,
        shouldForceUpdate: false,
        fileUrl: "20240722210327/build.zip",
        fileHash:
          "a5cbf59a627759a88d472c502423ff55a4f6cd1aafeed3536f6a5f6e870c2290",
        message: "",
        targetAppVersion: "1.0",
        id: "00000000-0000-0000-0000-000000000001",
        enabled: true,
      },
    ];

    const update = await getUpdateInfo(bundles, {
      appVersion: "1.0",
      bundleId: NIL_UUID,
      platform: "ios",
    });
    expect(update).toStrictEqual({
      id: "00000000-0000-0000-0000-000000000001",
      shouldForceUpdate: false,
      status: "UPDATE",
      fileUrl: "20240722210327/build.zip",
      fileHash:
        "a5cbf59a627759a88d472c502423ff55a4f6cd1aafeed3536f6a5f6e870c2290",
    });
  });

  it("forces a rollback if no matching bundle exists for the provided bundleId", async () => {
    const bundles: Bundle[] = [];

    const update = await getUpdateInfo(bundles, {
      appVersion: "1.0",
      bundleId: "00000000-0000-0000-0000-000000000002",
      platform: "ios",
    });
    expect(update).toStrictEqual({
      fileUrl: null,
      fileHash: null,
      id: NIL_UUID,
      shouldForceUpdate: true, // Cause the app to reload
      status: "ROLLBACK",
    });
  });

  it("returns null if the user is already up-to-date with an available bundle", async () => {
    const bundles: Bundle[] = [
      {
        ...DEFAULT_BUNDLE,
        targetAppVersion: "1.0",
        shouldForceUpdate: false,
        enabled: true,
        id: "00000000-0000-0000-0000-000000000002",
      },
      {
        ...DEFAULT_BUNDLE,
        targetAppVersion: "1.0",
        shouldForceUpdate: false,
        enabled: true,
        id: "00000000-0000-0000-0000-000000000001",
      },
    ];

    const update = await getUpdateInfo(bundles, {
      appVersion: "1.0",
      bundleId: "00000000-0000-0000-0000-000000000002",
      platform: "ios",
    });
    expect(update).toBeNull();
  });

  it("triggers a rollback if the previously used bundle no longer exists", async () => {
    const bundles: Bundle[] = [
      {
        ...DEFAULT_BUNDLE,
        targetAppVersion: "1.0",
        shouldForceUpdate: false,
        enabled: true,
        id: "00000000-0000-0000-0000-000000000001",
      },
    ];

    const update = await getUpdateInfo(bundles, {
      appVersion: "1.0",
      bundleId: "00000000-0000-0000-0000-000000000002",
      platform: "ios",
    });
    expect(update).toStrictEqual({
      fileHash: "hash",
      fileUrl: "http://example.com/bundle.zip",
      id: "00000000-0000-0000-0000-000000000001",
      shouldForceUpdate: true,
      status: "ROLLBACK",
    });
  });

  it("selects the next available bundle even if shouldForceUpdate is false", async () => {
    const bundles: Bundle[] = [
      {
        ...DEFAULT_BUNDLE,
        targetAppVersion: "1.0",
        shouldForceUpdate: false,
        enabled: true,
        id: "00000000-0000-0000-0000-000000000003",
      },
      {
        ...DEFAULT_BUNDLE,
        targetAppVersion: "1.0",
        shouldForceUpdate: false,
        enabled: true,
        id: "00000000-0000-0000-0000-000000000002",
      },
      {
        ...DEFAULT_BUNDLE,
        targetAppVersion: "1.0",
        shouldForceUpdate: false,
        enabled: true,
        id: "00000000-0000-0000-0000-000000000001",
      },
    ];

    const update = await getUpdateInfo(bundles, {
      appVersion: "1.0",
      bundleId: "00000000-0000-0000-0000-000000000002",
      platform: "ios",
    });
    expect(update).toStrictEqual({
      fileUrl: "http://example.com/bundle.zip",
      fileHash: "hash",
      id: "00000000-0000-0000-0000-000000000003",
      shouldForceUpdate: false,
      status: "UPDATE",
    });
  });

  it("applies the highest available bundle even if the app version is unchanged", async () => {
    const bundles: Bundle[] = [
      {
        ...DEFAULT_BUNDLE,
        targetAppVersion: "1.0",
        shouldForceUpdate: false,
        enabled: true,
        id: "00000000-0000-0000-0000-000000000005", // Higher than the current version
      },
      {
        ...DEFAULT_BUNDLE,
        targetAppVersion: "1.0",
        shouldForceUpdate: false,
        enabled: true,
        id: "00000000-0000-0000-0000-000000000004",
      },
      {
        ...DEFAULT_BUNDLE,
        platform: "ios",
        targetAppVersion: "1.0",
        shouldForceUpdate: false,
        enabled: true,
        id: "00000000-0000-0000-0000-000000000003",
      },
      {
        ...DEFAULT_BUNDLE,
        targetAppVersion: "1.0",
        shouldForceUpdate: false,
        enabled: true,
        id: "00000000-0000-0000-0000-000000000002",
      },
      {
        ...DEFAULT_BUNDLE,
        targetAppVersion: "1.0",
        shouldForceUpdate: false,
        enabled: true,
        id: "00000000-0000-0000-0000-000000000001",
      },
    ];

    const update = await getUpdateInfo(bundles, {
      appVersion: "1.0",
      bundleId: "00000000-0000-0000-0000-000000000002",
      platform: "ios",
    });
    expect(update).toStrictEqual({
      fileUrl: "http://example.com/bundle.zip",
      fileHash: "hash",
      id: "00000000-0000-0000-0000-000000000005",
      shouldForceUpdate: false,
      status: "UPDATE",
    });
  });

  it("returns null if the newest matching bundle is disabled", async () => {
    const bundles: Bundle[] = [
      {
        ...DEFAULT_BUNDLE,
        targetAppVersion: "1.0",
        shouldForceUpdate: true,
        enabled: false, // Disabled
        id: "00000000-0000-0000-0000-000000000003",
      },
      {
        ...DEFAULT_BUNDLE,
        targetAppVersion: "1.0",
        shouldForceUpdate: true,
        enabled: true,
        id: "00000000-0000-0000-0000-000000000002",
      },
      {
        ...DEFAULT_BUNDLE,
        targetAppVersion: "1.0",
        shouldForceUpdate: false,
        enabled: true,
        id: "00000000-0000-0000-0000-000000000001",
      },
    ];

    const update = await getUpdateInfo(bundles, {
      appVersion: "1.0",
      bundleId: "00000000-0000-0000-0000-000000000002",
      platform: "ios",
    });
    expect(update).toBeNull();
  });

  it("rolls back to an older enabled bundle if the current one is disabled", async () => {
    const bundles: Bundle[] = [
      {
        ...DEFAULT_BUNDLE,
        targetAppVersion: "1.0",
        shouldForceUpdate: true,
        enabled: false, // Disabled
        id: "00000000-0000-0000-0000-000000000002",
      },
      {
        ...DEFAULT_BUNDLE,
        targetAppVersion: "1.0",
        shouldForceUpdate: false,
        enabled: true,
        id: "00000000-0000-0000-0000-000000000001",
      },
    ];

    const update = await getUpdateInfo(bundles, {
      appVersion: "1.0",
      bundleId: "00000000-0000-0000-0000-000000000002",
      platform: "ios",
    });

    expect(update).toStrictEqual({
      fileUrl: "http://example.com/bundle.zip",
      fileHash: "hash",
      id: "00000000-0000-0000-0000-000000000001",
      shouldForceUpdate: true, // Cause the app to reload
      status: "ROLLBACK",
    });
  });

  it("rolls back to the original bundle when all available bundles are disabled", async () => {
    const bundles: Bundle[] = [
      {
        ...DEFAULT_BUNDLE,
        targetAppVersion: "1.0",
        shouldForceUpdate: true,
        enabled: false, // Disabled
        id: "00000000-0000-0000-0000-000000000002",
      },
      {
        ...DEFAULT_BUNDLE,
        targetAppVersion: "1.0",
        shouldForceUpdate: false,
        enabled: false, // Disabled
        id: "00000000-0000-0000-0000-000000000001",
      },
    ];

    const update = await getUpdateInfo(bundles, {
      appVersion: "1.0",
      bundleId: "00000000-0000-0000-0000-000000000002",
      platform: "ios",
    });
    expect(update).toStrictEqual({
      id: NIL_UUID,
      fileUrl: null,
      fileHash: null,
      shouldForceUpdate: true, // Cause the app to reload
      status: "ROLLBACK",
    });
  });
  it("returns null when bundleId is from build time and no updates exist in the database (TestFlight)", async () => {
    const bundles: Bundle[] = [];

    const update = await getUpdateInfo(bundles, {
      appVersion: "1.0",
      bundleId: "0195695b-8b50-7000-8000-000000000000", // Build-time generated BUNDLE_ID
      platform: "ios",
    });
    expect(update).toBeNull();
  });

  it("returns null when bundleId is from build time and only an older update exists (TestFlight)", async () => {
    const bundles: Bundle[] = [
      {
        ...DEFAULT_BUNDLE,
        id: "01956886-e1e8-7a7a-9666-4573712f3d58", // Old bundle (previous update)
        targetAppVersion: "1.0",
        shouldForceUpdate: false,
        enabled: true,
      },
    ];

    const update = await getUpdateInfo(bundles, {
      appVersion: "1.0",
      bundleId: "0195695b-8b50-7000-8000-000000000000", // Build-time generated BUNDLE_ID
      platform: "ios",
    });
    expect(update).toBeNull();
  });

  it("returns the latest available update when bundleId is from build time and a newer update exists (TestFlight)", async () => {
    const bundles: Bundle[] = [
      {
        ...DEFAULT_BUNDLE,
        id: "0195695f-06ea-77b1-8afe-df3c00a22536", // New update available
        targetAppVersion: "1.0",
        shouldForceUpdate: false,
        enabled: true,
      },
    ];

    const update = await getUpdateInfo(bundles, {
      appVersion: "1.0",
      bundleId: "0195695b-8b50-7000-8000-000000000000", // Build-time generated BUNDLE_ID
      platform: "ios",
    });
    expect(update).toStrictEqual({
      fileUrl: "http://example.com/bundle.zip",
      fileHash: "hash",
      id: "0195695f-06ea-77b1-8afe-df3c00a22536", // New update
      shouldForceUpdate: false,
      status: "UPDATE",
    });
  });

  it("returns the latest available update when bundleId is from build time and both an old and a new update exist (TestFlight)", async () => {
    const bundles: Bundle[] = [
      {
        ...DEFAULT_BUNDLE,
        id: "0195695f-06ea-77b1-8afe-df3c00a22536", // New update available
        targetAppVersion: "1.0",
        shouldForceUpdate: false,
        enabled: true,
      },
      {
        ...DEFAULT_BUNDLE,
        id: "01956886-e1e8-7a7a-9666-4573712f3d58", // Old update
        targetAppVersion: "1.0",
        shouldForceUpdate: false,
        enabled: true,
      },
    ];

    const update = await getUpdateInfo(bundles, {
      appVersion: "1.0",
      bundleId: "0195695b-8b50-7000-8000-000000000000", // Build-time generated BUNDLE_ID
      platform: "ios",
    });
    expect(update).toStrictEqual({
      fileUrl: "http://example.com/bundle.zip",
      fileHash: "hash",
      id: "0195695f-06ea-77b1-8afe-df3c00a22536", // New update
      shouldForceUpdate: false,
      status: "UPDATE",
    });
  });
};
