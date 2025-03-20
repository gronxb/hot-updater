import { expect, it } from "vitest";
import type { Bundle, GetBundlesArgs, UpdateInfo } from "../types";
import { NIL_UUID } from "../uuid";

const DEFAULT_BUNDLE = {
  message: "hello",
  platform: "ios",
  gitCommitHash: null,
  fileHash: "hash",
  channel: "production",
} as const;

const INIT_BUNDLE_ROLLBACK_UPDATE_INFO = {
  id: NIL_UUID,
  message: null,
  shouldForceUpdate: true,
  status: "ROLLBACK",
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
      message: "hello",
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
      message: "hello",
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
      message: "hello",
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
      message: "hello",
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
      message: "hello",
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
      message: "hello",
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
        fileHash:
          "a5cbf59a627759a88d472c502423ff55a4f6cd1aafeed3536f6a5f6e870c2290",
        message: "hi",
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
      message: "hi",
    });
  });

  it("forces a rollback if no matching bundle exists for the provided bundleId", async () => {
    const bundles: Bundle[] = [];

    const update = await getUpdateInfo(bundles, {
      appVersion: "1.0",
      bundleId: "00000000-0000-0000-0000-000000000002",
      platform: "ios",
    });
    expect(update).toStrictEqual(INIT_BUNDLE_ROLLBACK_UPDATE_INFO);
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
      message: "hello",
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
      message: "hello",
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
      message: "hello",
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
      message: "hello",
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
    expect(update).toStrictEqual(INIT_BUNDLE_ROLLBACK_UPDATE_INFO);
  });

  it("returns null when there is an available bundle lower than minBundleId", async () => {
    const bundles: Bundle[] = [
      {
        ...DEFAULT_BUNDLE,
        targetAppVersion: "1.0",
        shouldForceUpdate: false,
        enabled: true,
        id: "0195715a-ce29-7c55-97d3-53af4fe369b7", // 2025-03-07T16:05:31.305Z
      },
    ];

    const update = await getUpdateInfo(bundles, {
      appVersion: "1.0",
      minBundleId: "0195715b-9591-7000-8000-000000000000", //2025-03-07T16:06:22.353Z
      bundleId: "0195715b-9591-7000-8000-000000000000", // Build-time generated BUNDLE_ID
      platform: "ios",
    });
    expect(update).toBeNull();
  });

  it("returns the bundle when there is an available bundle higher than minBundleId", async () => {
    const bundles: Bundle[] = [
      {
        ...DEFAULT_BUNDLE,
        targetAppVersion: "1.0",
        shouldForceUpdate: false,
        enabled: true,
        id: "0195715d-42db-7475-9204-31819efc2f1d", // 2025-03-07T16:08:12.251Z
      },
      {
        ...DEFAULT_BUNDLE,
        targetAppVersion: "1.0",
        shouldForceUpdate: false,
        enabled: true,
        id: "0195715a-ce29-7c55-97d3-53af4fe369b7", // 2025-03-07T16:05:31.305Z
      },
    ];

    const update = await getUpdateInfo(bundles, {
      appVersion: "1.0",
      minBundleId: "0195715b-9591-7000-8000-000000000000", //2025-03-07T16:06:22.353Z
      bundleId: "0195715b-9591-7000-8000-000000000000", // Build-time generated BUNDLE_ID
      platform: "ios",
    });
    expect(update).toStrictEqual({
      id: "0195715d-42db-7475-9204-31819efc2f1d", // 2025-03-07T16:08:12.251Z
      message: "hello",
      shouldForceUpdate: false,
      status: "UPDATE",
    });
  });

  it("rolls back to initial bundle when current bundle is disabled and only bundles lower than minBundleId exist", async () => {
    const bundles: Bundle[] = [
      {
        ...DEFAULT_BUNDLE,
        targetAppVersion: "1.0",
        shouldForceUpdate: false,
        enabled: false, // disabled
        id: "0195715d-42db-7475-9204-31819efc2f1d", // 2025-03-07T16:08:12.251Z
      },
      {
        ...DEFAULT_BUNDLE,
        targetAppVersion: "1.0",
        shouldForceUpdate: false,
        enabled: true,
        id: "0195715a-ce29-7c55-97d3-53af4fe369b7", // 2025-03-07T16:05:31.305Z
      },
    ];

    const update = await getUpdateInfo(bundles, {
      appVersion: "1.0",
      minBundleId: "0195715b-9591-7000-8000-000000000000", //2025-03-07T16:06:22.353Z
      bundleId: "0195715d-42db-7475-9204-31819efc2f1d", // 2025-03-07T16:08:12.251Z
      platform: "ios",
    });
    expect(update).toStrictEqual(INIT_BUNDLE_ROLLBACK_UPDATE_INFO);
  });

  it("rolls back to initial bundle when current bundle does not exist and only bundles lower than minBundleId exist", async () => {
    const bundles: Bundle[] = [
      {
        ...DEFAULT_BUNDLE,
        targetAppVersion: "1.0",
        shouldForceUpdate: false,
        enabled: true,
        id: "0195715a-ce29-7c55-97d3-53af4fe369b7", // 2025-03-07T16:05:31.305Z
      },
    ];

    const update = await getUpdateInfo(bundles, {
      appVersion: "1.0",
      minBundleId: "0195715b-9591-7000-8000-000000000000", //2025-03-07T16:06:22.353Z
      bundleId: "0195715d-42db-7475-9204-31819efc2f1d", // 2025-03-07T16:08:12.251Z
      platform: "ios",
    });
    expect(update).toStrictEqual(INIT_BUNDLE_ROLLBACK_UPDATE_INFO);
  });

  it("returns null when current bundle is enabled and no updates are available", async () => {
    const bundles: Bundle[] = [
      {
        ...DEFAULT_BUNDLE,
        targetAppVersion: "1.0",
        shouldForceUpdate: false,
        enabled: true, // disabled
        id: "0195715d-42db-7475-9204-31819efc2f1d", // 2025-03-07T16:08:12.251Z
      },
      {
        ...DEFAULT_BUNDLE,
        targetAppVersion: "1.0",
        shouldForceUpdate: false,
        enabled: true,
        id: "0195715a-ce29-7c55-97d3-53af4fe369b7", // 2025-03-07T16:05:31.305Z
      },
    ];

    const update = await getUpdateInfo(bundles, {
      appVersion: "1.0",
      minBundleId: "0195715b-9591-7000-8000-000000000000", //2025-03-07T16:06:22.353Z
      bundleId: "0195715d-42db-7475-9204-31819efc2f1d", // 2025-03-07T16:08:12.251Z
      platform: "ios",
    });
    expect(update).toBeNull();
  });

  it("rolls back when current bundle does not exist in DB and no bundles higher than minBundleId exist", async () => {
    const bundles: Bundle[] = [
      {
        ...DEFAULT_BUNDLE,
        targetAppVersion: "1.0",
        shouldForceUpdate: false,
        enabled: true,
        id: "01957165-bee7-7df3-a25d-6686f01b02ba", //2025-03-07T16:17:28.295Z
      },
      {
        ...DEFAULT_BUNDLE,
        targetAppVersion: "1.0",
        shouldForceUpdate: false,
        enabled: true,
        id: "01957165-19fb-75af-a361-131c17a65ef2", // 2025-03-07T16:16:46.075Z
      },
      {
        ...DEFAULT_BUNDLE,
        targetAppVersion: "1.0",
        shouldForceUpdate: false,
        enabled: true,
        id: "01957164-fbc6-785f-98ce-a6ae459f6e4f", // 2025-03-07T16:16:38.342Z
      },
    ];

    const update = await getUpdateInfo(bundles, {
      appVersion: "1.0",
      minBundleId: "01957166-6e63-7000-8000-000000000000", // 2025-03-07T16:18:13.219Z
      bundleId: "01957167-0389-7064-8d86-f8af7950daed", // 2025-03-07T16:18:51.401Z
      platform: "ios",
    });
    expect(update).toStrictEqual(INIT_BUNDLE_ROLLBACK_UPDATE_INFO);
  });

  it("rolls back to the bundle when current bundle does not exist in DB and a bundle exists that is higher than minBundleId but lower than current bundleId", async () => {
    const bundles: Bundle[] = [
      {
        ...DEFAULT_BUNDLE,
        targetAppVersion: "1.0",
        shouldForceUpdate: false,
        enabled: true,
        id: "0195716c-82f5-7e5e-ac8c-d4fbf5bc7555", // 2025-03-07T16:24:51.701Z
      },
      {
        ...DEFAULT_BUNDLE,
        targetAppVersion: "1.0",
        shouldForceUpdate: false,
        enabled: true,
        id: "01957167-0389-7064-8d86-f8af7950daed", // 2025-03-07T16:18:51.401Z
      },
      {
        ...DEFAULT_BUNDLE,
        targetAppVersion: "1.0",
        shouldForceUpdate: false,
        enabled: true,
        id: "01957165-bee7-7df3-a25d-6686f01b02ba", //2025-03-07T16:17:28.295Z
      },
      {
        ...DEFAULT_BUNDLE,
        targetAppVersion: "1.0",
        shouldForceUpdate: false,
        enabled: true,
        id: "01957165-19fb-75af-a361-131c17a65ef2", // 2025-03-07T16:16:46.075Z
      },
      {
        ...DEFAULT_BUNDLE,
        targetAppVersion: "1.0",
        shouldForceUpdate: false,
        enabled: true,
        id: "01957164-fbc6-785f-98ce-a6ae459f6e4f", // 2025-03-07T16:16:38.342Z
      },
    ];

    const update = await getUpdateInfo(bundles, {
      appVersion: "1.0",
      minBundleId: "01957166-6e63-7000-8000-000000000000", // 2025-03-07T16:18:13.219Z
      bundleId: "0195716c-d426-7308-9924-c3f8cb2eaaad", // 2025-03-07T16:25:12.486Z
      platform: "ios",
    });
    expect(update).toStrictEqual({
      id: "0195716c-82f5-7e5e-ac8c-d4fbf5bc7555", // 2025-03-07T16:24:51.701Z
      message: "hello",
      shouldForceUpdate: true,
      status: "ROLLBACK",
    });
  });

  it("returns null when installed bundle id exactly equals minBundleId and no newer bundle is available", async () => {
    const bundles: Bundle[] = [
      {
        ...DEFAULT_BUNDLE,
        targetAppVersion: "1.0",
        shouldForceUpdate: false,
        enabled: true,
        id: "01957179-d99d-7fbb-bc1e-feff6b3236f0", // only available bundle, equal to minBundleId
      },
    ];

    const update = await getUpdateInfo(bundles, {
      appVersion: "1.0",
      minBundleId: "0195715b-9591-7000-8000-000000000000",
      bundleId: "01957179-d99d-7fbb-bc1e-feff6b3236f0",
      platform: "ios",
    });
    expect(update).toBeNull();
  });

  it("does not update bundles from different channels", async () => {
    const bundles: Bundle[] = [
      {
        ...DEFAULT_BUNDLE,
        targetAppVersion: "1.0",
        shouldForceUpdate: false,
        enabled: true,
        channel: "beta",
        id: "00000000-0000-0000-0000-000000000001",
      },
    ];

    const update = await getUpdateInfo(bundles, {
      appVersion: "1.0",
      bundleId: NIL_UUID,
      platform: "ios",
      channel: "production",
    });

    expect(update).toBeNull();
  });

  it("updates bundles from the same channel", async () => {
    const bundles: Bundle[] = [
      {
        ...DEFAULT_BUNDLE,
        targetAppVersion: "1.0",
        shouldForceUpdate: false,
        enabled: true,
        channel: "beta",
        id: "00000000-0000-0000-0000-000000000001",
      },
    ];

    const update = await getUpdateInfo(bundles, {
      appVersion: "1.0",
      bundleId: NIL_UUID,
      platform: "ios",
      channel: "beta",
    });

    expect(update).toStrictEqual({
      id: "00000000-0000-0000-0000-000000000001",
      message: "hello",
      shouldForceUpdate: false,
      status: "UPDATE",
    });
  });

  it("returns null when minBundleId is greater than current bundle", async () => {
    const bundles: Bundle[] = [
      {
        ...DEFAULT_BUNDLE,
        enabled: true,
        shouldForceUpdate: false,
        targetAppVersion: "1.0",
        id: "01957b63-7d11-7281-b8e7-1120ccfdb8ab",
      },
    ];

    const update = await getUpdateInfo(bundles, {
      appVersion: "1.0",
      bundleId: "01957b63-7d11-7281-b8e7-1120ccfdb8ab",
      platform: "ios",
      minBundleId: "01957bb4-b13c-7000-8000-000000000000",
      channel: "production",
    });

    expect(update).toBeNull();
  });
};
