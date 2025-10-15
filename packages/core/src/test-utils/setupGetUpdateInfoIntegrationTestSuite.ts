import { describe, expect, it } from "vitest";
import type { Bundle, GetBundlesArgs, UpdateInfo } from "../types";
import { NIL_UUID } from "../uuid";

const DEFAULT_BUNDLE_APP_VERSION_STRATEGY = {
  message: "hello",
  platform: "ios",
  gitCommitHash: null,
  fileHash: "hash",
  channel: "production",
  storageUri: "storage://my-app/bundle.zip",
  fingerprintHash: null,
} as const;

const DEFAULT_BUNDLE_FINGERPRINT_STRATEGY = {
  message: "hello",
  platform: "ios",
  gitCommitHash: null,
  fileHash: "hash",
  channel: "production",
  storageUri: "storage://my-app/bundle.zip",
  targetAppVersion: null,
} as const;

const INIT_BUNDLE_ROLLBACK_UPDATE_INFO = {
  id: NIL_UUID,
  message: null,
  shouldForceUpdate: true,
  status: "ROLLBACK",
  storageUri: null,
} as const;

export interface IntegrationTestContext {
  /**
   * Setup function to insert bundles into the database/storage
   */
  setupBundles: (bundles: Bundle[]) => Promise<void>;

  /**
   * Cleanup function to reset the database/storage state
   */
  cleanup: () => Promise<void>;

  /**
   * Function to make HTTP request to the update endpoint
   */
  fetchUpdateInfo: (args: GetBundlesArgs) => Promise<UpdateInfo | null>;
}

export const setupGetUpdateInfoIntegrationTestSuite = (
  context: IntegrationTestContext,
) => {
  const { setupBundles, cleanup, fetchUpdateInfo } = context;

  describe("app version strategy", () => {
    it("applies an update when a '*' bundle is available", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          targetAppVersion: "*",
          shouldForceUpdate: false,
          enabled: true,
          id: "00000000-0000-0000-0000-000000000001",
        },
      ];

      await setupBundles(bundles);

      const update = await fetchUpdateInfo({
        appVersion: "1.0",
        bundleId: NIL_UUID,
        platform: "ios",
        _updateStrategy: "appVersion",
      });

      expect(update).toMatchObject({
        id: "00000000-0000-0000-0000-000000000001",
        message: "hello",
        shouldForceUpdate: false,
        status: "UPDATE",
      });
    });

    it("returns null when no bundles are provided", async () => {
      await setupBundles([]);

      const update = await fetchUpdateInfo({
        appVersion: "1.0",
        bundleId: NIL_UUID,
        platform: "ios",
        _updateStrategy: "appVersion",
      });

      expect(update).toBeNull();
    });

    it("returns null when the app version does not qualify for the available higher version", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          targetAppVersion: "1.1",
          enabled: true,
          id: "00000000-0000-0000-0000-000000000001",
          shouldForceUpdate: false,
        },
      ];

      await setupBundles(bundles);

      const update = await fetchUpdateInfo({
        appVersion: "1.0",
        bundleId: NIL_UUID,
        platform: "ios",
        _updateStrategy: "appVersion",
      });

      expect(update).toBeNull();
    });

    it("tests target app version compatibility with available higher version", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          targetAppVersion: "1.0.0",
          enabled: true,
          id: "01963024-c131-7971-8725-ab47e232df41",
          shouldForceUpdate: false,
        },
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          targetAppVersion: "1.0.1",
          enabled: true,
          id: "01963024-c131-7971-8725-ab47e232df42",
          shouldForceUpdate: false,
        },
      ];

      await setupBundles(bundles);

      const update = await fetchUpdateInfo({
        appVersion: "1.0.0",
        bundleId: "01963024-c131-7971-8725-ab47e232df41",
        platform: "ios",
        _updateStrategy: "appVersion",
      });

      expect(update).toBeNull();
    });

    it("applies an update when a higher semver-compatible bundle is available", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          targetAppVersion: "1.x.x",
          enabled: true,
          id: "00000000-0000-0000-0000-000000000001",
          shouldForceUpdate: false,
        },
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          targetAppVersion: "1.0",
          enabled: true,
          id: "00000000-0000-0000-0000-000000000002",
          shouldForceUpdate: false,
        },
      ];

      await setupBundles(bundles);

      const update = await fetchUpdateInfo({
        appVersion: "1.0",
        bundleId: NIL_UUID,
        platform: "ios",
        _updateStrategy: "appVersion",
      });

      expect(update).toMatchObject({
        id: "00000000-0000-0000-0000-000000000002",
        shouldForceUpdate: false,
        status: "UPDATE",
        message: "hello",
      });
    });

    it("applies an update if shouldForceUpdate is true for a matching version", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          targetAppVersion: "1.0",
          enabled: true,
          id: "00000000-0000-0000-0000-000000000001",
          shouldForceUpdate: true,
        },
      ];

      await setupBundles(bundles);

      const update = await fetchUpdateInfo({
        appVersion: "1.0",
        bundleId: NIL_UUID,
        platform: "ios",
        _updateStrategy: "appVersion",
      });

      expect(update).toMatchObject({
        id: "00000000-0000-0000-0000-000000000001",
        shouldForceUpdate: true,
        status: "UPDATE",
        message: "hello",
      });
    });

    it("applies an update for a matching version even if shouldForceUpdate is false", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          targetAppVersion: "1.0",
          enabled: true,
          id: "00000000-0000-0000-0000-000000000001",
          shouldForceUpdate: false,
        },
      ];

      await setupBundles(bundles);

      const update = await fetchUpdateInfo({
        appVersion: "1.0",
        bundleId: NIL_UUID,
        platform: "ios",
        _updateStrategy: "appVersion",
      });

      expect(update).toMatchObject({
        id: "00000000-0000-0000-0000-000000000001",
        shouldForceUpdate: false,
        status: "UPDATE",
        message: "hello",
      });
    });

    it("applies an update when the app version is the same but the bundle is still considered higher", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          targetAppVersion: "1.0",
          shouldForceUpdate: false,
          enabled: true,
          id: "00000000-0000-0000-0000-000000000005",
        },
      ];

      await setupBundles(bundles);

      const update = await fetchUpdateInfo({
        appVersion: "1.0",
        bundleId: NIL_UUID,
        platform: "ios",
        _updateStrategy: "appVersion",
      });

      expect(update).toMatchObject({
        id: "00000000-0000-0000-0000-000000000005",
        shouldForceUpdate: false,
        message: "hello",
        status: "UPDATE",
      });
    });

    it("falls back to an older enabled bundle when the latest is disabled", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          targetAppVersion: "1.0",
          shouldForceUpdate: true,
          enabled: false,
          id: "00000000-0000-0000-0000-000000000002",
        },
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          targetAppVersion: "1.0",
          shouldForceUpdate: false,
          enabled: true,
          id: "00000000-0000-0000-0000-000000000001",
        },
      ];

      await setupBundles(bundles);

      const update = await fetchUpdateInfo({
        appVersion: "1.0",
        bundleId: NIL_UUID,
        platform: "ios",
        _updateStrategy: "appVersion",
      });

      expect(update).toMatchObject({
        message: "hello",
        id: "00000000-0000-0000-0000-000000000001",
        shouldForceUpdate: false,
        status: "UPDATE",
      });
    });

    it("returns null if all bundles are disabled", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          targetAppVersion: "1.0",
          shouldForceUpdate: true,
          enabled: false,
          id: "00000000-0000-0000-0000-000000000002",
        },
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          targetAppVersion: "1.0",
          shouldForceUpdate: false,
          enabled: false,
          id: "00000000-0000-0000-0000-000000000001",
        },
      ];

      await setupBundles(bundles);

      const update = await fetchUpdateInfo({
        appVersion: "1.0",
        bundleId: NIL_UUID,
        platform: "ios",
        _updateStrategy: "appVersion",
      });

      expect(update).toBeNull();
    });

    it("triggers a rollback if the latest bundle is disabled and no other updates are enabled", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          targetAppVersion: "1.0",
          shouldForceUpdate: true,
          enabled: false,
          id: "00000000-0000-0000-0000-000000000002",
        },
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          targetAppVersion: "1.0",
          shouldForceUpdate: false,
          enabled: false,
          id: "00000000-0000-0000-0000-000000000001",
        },
      ];

      await setupBundles(bundles);

      const update = await fetchUpdateInfo({
        appVersion: "1.0",
        bundleId: NIL_UUID,
        platform: "ios",
        _updateStrategy: "appVersion",
      });

      expect(update).toStrictEqual(null);
    });

    it("applies an update when a same-version bundle is available and enabled", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          shouldForceUpdate: false,
          fileHash:
            "a5cbf59a627759a88d472c502423ff55a4f6cd1aafeed3536f6a5f6e870c2290",
          message: "hi",
          targetAppVersion: "1.0",
          id: "00000000-0000-0000-0000-000000000001",
          enabled: true,
        },
      ];

      await setupBundles(bundles);

      const update = await fetchUpdateInfo({
        appVersion: "1.0",
        bundleId: NIL_UUID,
        platform: "ios",
        _updateStrategy: "appVersion",
      });

      expect(update).toMatchObject({
        id: "00000000-0000-0000-0000-000000000001",
        shouldForceUpdate: false,
        status: "UPDATE",
        message: "hi",
      });
    });

    it("forces a rollback if no matching bundle exists for the provided bundleId", async () => {
      await setupBundles([]);

      const update = await fetchUpdateInfo({
        appVersion: "1.0",
        bundleId: "00000000-0000-0000-0000-000000000002",
        platform: "ios",
        _updateStrategy: "appVersion",
      });

      expect(update).toMatchObject(INIT_BUNDLE_ROLLBACK_UPDATE_INFO);
    });

    it("returns null if the user is already up-to-date with an available bundle", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          targetAppVersion: "1.0",
          shouldForceUpdate: false,
          enabled: true,
          id: "00000000-0000-0000-0000-000000000002",
        },
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          targetAppVersion: "1.0",
          shouldForceUpdate: false,
          enabled: true,
          id: "00000000-0000-0000-0000-000000000001",
        },
      ];

      await setupBundles(bundles);

      const update = await fetchUpdateInfo({
        appVersion: "1.0",
        bundleId: "00000000-0000-0000-0000-000000000002",
        platform: "ios",
        _updateStrategy: "appVersion",
      });

      expect(update).toBeNull();
    });

    it("triggers a rollback if the previously used bundle no longer exists", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          targetAppVersion: "1.0",
          shouldForceUpdate: false,
          enabled: true,
          id: "00000000-0000-0000-0000-000000000001",
        },
      ];

      await setupBundles(bundles);

      const update = await fetchUpdateInfo({
        appVersion: "1.0",
        bundleId: "00000000-0000-0000-0000-000000000002",
        platform: "ios",
        _updateStrategy: "appVersion",
      });

      expect(update).toMatchObject({
        message: "hello",
        id: "00000000-0000-0000-0000-000000000001",
        shouldForceUpdate: true,
        status: "ROLLBACK",
      });
    });

    it("selects the next available bundle even if shouldForceUpdate is false", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          targetAppVersion: "1.0",
          shouldForceUpdate: false,
          enabled: true,
          id: "00000000-0000-0000-0000-000000000003",
        },
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          targetAppVersion: "1.0",
          shouldForceUpdate: false,
          enabled: true,
          id: "00000000-0000-0000-0000-000000000002",
        },
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          targetAppVersion: "1.0",
          shouldForceUpdate: false,
          enabled: true,
          id: "00000000-0000-0000-0000-000000000001",
        },
      ];

      await setupBundles(bundles);

      const update = await fetchUpdateInfo({
        appVersion: "1.0",
        bundleId: "00000000-0000-0000-0000-000000000002",
        platform: "ios",
        _updateStrategy: "appVersion",
      });

      expect(update).toMatchObject({
        message: "hello",
        id: "00000000-0000-0000-0000-000000000003",
        shouldForceUpdate: false,
        status: "UPDATE",
      });
    });

    it("applies the highest available bundle even if the app version is unchanged", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          targetAppVersion: "1.0",
          shouldForceUpdate: false,
          enabled: true,
          id: "00000000-0000-0000-0000-000000000005",
        },
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          targetAppVersion: "1.0",
          shouldForceUpdate: false,
          enabled: true,
          id: "00000000-0000-0000-0000-000000000004",
        },
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          platform: "ios",
          targetAppVersion: "1.0",
          shouldForceUpdate: false,
          enabled: true,
          id: "00000000-0000-0000-0000-000000000003",
        },
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          targetAppVersion: "1.0",
          shouldForceUpdate: false,
          enabled: true,
          id: "00000000-0000-0000-0000-000000000002",
        },
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          targetAppVersion: "1.0",
          shouldForceUpdate: false,
          enabled: true,
          id: "00000000-0000-0000-0000-000000000001",
        },
      ];

      await setupBundles(bundles);

      const update = await fetchUpdateInfo({
        appVersion: "1.0",
        bundleId: "00000000-0000-0000-0000-000000000002",
        platform: "ios",
        _updateStrategy: "appVersion",
      });

      expect(update).toMatchObject({
        message: "hello",
        id: "00000000-0000-0000-0000-000000000005",
        shouldForceUpdate: false,
        status: "UPDATE",
      });
    });

    it("returns null if the newest matching bundle is disabled", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          targetAppVersion: "1.0",
          shouldForceUpdate: true,
          enabled: false,
          id: "00000000-0000-0000-0000-000000000003",
        },
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          targetAppVersion: "1.0",
          shouldForceUpdate: true,
          enabled: true,
          id: "00000000-0000-0000-0000-000000000002",
        },
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          targetAppVersion: "1.0",
          shouldForceUpdate: false,
          enabled: true,
          id: "00000000-0000-0000-0000-000000000001",
        },
      ];

      await setupBundles(bundles);

      const update = await fetchUpdateInfo({
        appVersion: "1.0",
        bundleId: "00000000-0000-0000-0000-000000000002",
        platform: "ios",
        _updateStrategy: "appVersion",
      });

      expect(update).toBeNull();
    });

    it("rolls back to an older enabled bundle if the current one is disabled", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          targetAppVersion: "1.0",
          shouldForceUpdate: true,
          enabled: false,
          id: "00000000-0000-0000-0000-000000000002",
        },
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          targetAppVersion: "1.0",
          shouldForceUpdate: false,
          enabled: true,
          id: "00000000-0000-0000-0000-000000000001",
        },
      ];

      await setupBundles(bundles);

      const update = await fetchUpdateInfo({
        appVersion: "1.0",
        bundleId: "00000000-0000-0000-0000-000000000002",
        platform: "ios",
        _updateStrategy: "appVersion",
      });

      expect(update).toMatchObject({
        message: "hello",
        id: "00000000-0000-0000-0000-000000000001",
        shouldForceUpdate: true,
        status: "ROLLBACK",
      });
    });

    it("rolls back to the original bundle when all available bundles are disabled", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          targetAppVersion: "1.0",
          shouldForceUpdate: true,
          enabled: false,
          id: "00000000-0000-0000-0000-000000000002",
        },
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          targetAppVersion: "1.0",
          shouldForceUpdate: false,
          enabled: false,
          id: "00000000-0000-0000-0000-000000000001",
        },
      ];

      await setupBundles(bundles);

      const update = await fetchUpdateInfo({
        appVersion: "1.0",
        bundleId: "00000000-0000-0000-0000-000000000002",
        platform: "ios",
        _updateStrategy: "appVersion",
      });

      expect(update).toMatchObject(INIT_BUNDLE_ROLLBACK_UPDATE_INFO);
    });

    it("returns null when there is an available bundle lower than minBundleId", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          targetAppVersion: "1.0",
          shouldForceUpdate: false,
          enabled: true,
          id: "0195715a-ce29-7c55-97d3-53af4fe369b7",
        },
      ];

      await setupBundles(bundles);

      const update = await fetchUpdateInfo({
        appVersion: "1.0",
        minBundleId: "0195715b-9591-7000-8000-000000000000",
        bundleId: "0195715b-9591-7000-8000-000000000000",
        platform: "ios",
        _updateStrategy: "appVersion",
      });

      expect(update).toBeNull();
    });

    it("returns the bundle when there is an available bundle higher than minBundleId", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          targetAppVersion: "1.0",
          shouldForceUpdate: false,
          enabled: true,
          id: "0195715d-42db-7475-9204-31819efc2f1d",
        },
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          targetAppVersion: "1.0",
          shouldForceUpdate: false,
          enabled: true,
          id: "0195715a-ce29-7c55-97d3-53af4fe369b7",
        },
      ];

      await setupBundles(bundles);

      const update = await fetchUpdateInfo({
        appVersion: "1.0",
        minBundleId: "0195715b-9591-7000-8000-000000000000",
        bundleId: "0195715b-9591-7000-8000-000000000000",
        platform: "ios",
        _updateStrategy: "appVersion",
      });

      expect(update).toMatchObject({
        id: "0195715d-42db-7475-9204-31819efc2f1d",
        message: "hello",
        shouldForceUpdate: false,
        status: "UPDATE",
      });
    });

    it("rolls back to initial bundle when current bundle is disabled and only bundles lower than minBundleId exist", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          targetAppVersion: "1.0",
          shouldForceUpdate: false,
          enabled: false,
          id: "0195715d-42db-7475-9204-31819efc2f1d",
        },
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          targetAppVersion: "1.0",
          shouldForceUpdate: false,
          enabled: true,
          id: "0195715a-ce29-7c55-97d3-53af4fe369b7",
        },
      ];

      await setupBundles(bundles);

      const update = await fetchUpdateInfo({
        appVersion: "1.0",
        minBundleId: "0195715b-9591-7000-8000-000000000000",
        bundleId: "0195715d-42db-7475-9204-31819efc2f1d",
        platform: "ios",
        _updateStrategy: "appVersion",
      });

      expect(update).toMatchObject(INIT_BUNDLE_ROLLBACK_UPDATE_INFO);
    });

    it("rolls back to initial bundle when current bundle does not exist and only bundles lower than minBundleId exist", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          targetAppVersion: "1.0",
          shouldForceUpdate: false,
          enabled: true,
          id: "0195715a-ce29-7c55-97d3-53af4fe369b7",
        },
      ];

      await setupBundles(bundles);

      const update = await fetchUpdateInfo({
        appVersion: "1.0",
        minBundleId: "0195715b-9591-7000-8000-000000000000",
        bundleId: "0195715d-42db-7475-9204-31819efc2f1d",
        platform: "ios",
        _updateStrategy: "appVersion",
      });

      expect(update).toMatchObject(INIT_BUNDLE_ROLLBACK_UPDATE_INFO);
    });

    it("returns null when current bundle is enabled and no updates are available", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          targetAppVersion: "1.0",
          shouldForceUpdate: false,
          enabled: true,
          id: "0195715d-42db-7475-9204-31819efc2f1d",
        },
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          targetAppVersion: "1.0",
          shouldForceUpdate: false,
          enabled: true,
          id: "0195715a-ce29-7c55-97d3-53af4fe369b7",
        },
      ];

      await setupBundles(bundles);

      const update = await fetchUpdateInfo({
        appVersion: "1.0",
        minBundleId: "0195715b-9591-7000-8000-000000000000",
        bundleId: "0195715d-42db-7475-9204-31819efc2f1d",
        platform: "ios",
        _updateStrategy: "appVersion",
      });

      expect(update).toBeNull();
    });

    it("rolls back when current bundle does not exist in DB and no bundles higher than minBundleId exist", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          targetAppVersion: "1.0",
          shouldForceUpdate: false,
          enabled: true,
          id: "01957165-bee7-7df3-a25d-6686f01b02ba",
        },
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          targetAppVersion: "1.0",
          shouldForceUpdate: false,
          enabled: true,
          id: "01957165-19fb-75af-a361-131c17a65ef2",
        },
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          targetAppVersion: "1.0",
          shouldForceUpdate: false,
          enabled: true,
          id: "01957164-fbc6-785f-98ce-a6ae459f6e4f",
        },
      ];

      await setupBundles(bundles);

      const update = await fetchUpdateInfo({
        appVersion: "1.0",
        minBundleId: "01957166-6e63-7000-8000-000000000000",
        bundleId: "01957167-0389-7064-8d86-f8af7950daed",
        platform: "ios",
        _updateStrategy: "appVersion",
      });

      expect(update).toMatchObject(INIT_BUNDLE_ROLLBACK_UPDATE_INFO);
    });

    it("rolls back to the bundle when current bundle does not exist in DB and a bundle exists that is higher than minBundleId but lower than current bundleId", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          targetAppVersion: "1.0",
          shouldForceUpdate: false,
          enabled: true,
          id: "0195716c-82f5-7e5e-ac8c-d4fbf5bc7555",
        },
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          targetAppVersion: "1.0",
          shouldForceUpdate: false,
          enabled: true,
          id: "01957167-0389-7064-8d86-f8af7950daed",
        },
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          targetAppVersion: "1.0",
          shouldForceUpdate: false,
          enabled: true,
          id: "01957165-bee7-7df3-a25d-6686f01b02ba",
        },
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          targetAppVersion: "1.0",
          shouldForceUpdate: false,
          enabled: true,
          id: "01957165-19fb-75af-a361-131c17a65ef2",
        },
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          targetAppVersion: "1.0",
          shouldForceUpdate: false,
          enabled: true,
          id: "01957164-fbc6-785f-98ce-a6ae459f6e4f",
        },
      ];

      await setupBundles(bundles);

      const update = await fetchUpdateInfo({
        appVersion: "1.0",
        minBundleId: "01957166-6e63-7000-8000-000000000000",
        bundleId: "0195716c-d426-7308-9924-c3f8cb2eaaad",
        platform: "ios",
        _updateStrategy: "appVersion",
      });

      expect(update).toMatchObject({
        id: "0195716c-82f5-7e5e-ac8c-d4fbf5bc7555",
        message: "hello",
        shouldForceUpdate: true,
        status: "ROLLBACK",
      });
    });

    it("returns null when installed bundle id exactly equals minBundleId and no newer bundle is available", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          targetAppVersion: "1.0",
          shouldForceUpdate: false,
          enabled: true,
          id: "01957179-d99d-7fbb-bc1e-feff6b3236f0",
        },
      ];

      await setupBundles(bundles);

      const update = await fetchUpdateInfo({
        appVersion: "1.0",
        minBundleId: "0195715b-9591-7000-8000-000000000000",
        bundleId: "01957179-d99d-7fbb-bc1e-feff6b3236f0",
        platform: "ios",
        _updateStrategy: "appVersion",
      });

      expect(update).toBeNull();
    });

    it("does not update bundles from different channels", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          targetAppVersion: "1.0",
          shouldForceUpdate: false,
          enabled: true,
          channel: "beta",
          id: "00000000-0000-0000-0000-000000000001",
        },
      ];

      await setupBundles(bundles);

      const update = await fetchUpdateInfo({
        appVersion: "1.0",
        bundleId: NIL_UUID,
        platform: "ios",
        channel: "production",
        _updateStrategy: "appVersion",
      });

      expect(update).toBeNull();
    });

    it("updates bundles from the same channel", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          targetAppVersion: "1.0",
          shouldForceUpdate: false,
          enabled: true,
          channel: "beta",
          id: "00000000-0000-0000-0000-000000000001",
        },
      ];

      await setupBundles(bundles);

      const update = await fetchUpdateInfo({
        appVersion: "1.0",
        bundleId: NIL_UUID,
        platform: "ios",
        channel: "beta",
        _updateStrategy: "appVersion",
      });

      expect(update).toMatchObject({
        id: "00000000-0000-0000-0000-000000000001",
        message: "hello",
        shouldForceUpdate: false,
        status: "UPDATE",
      });
    });

    it("returns null when minBundleId is greater than current bundle", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          enabled: true,
          shouldForceUpdate: false,
          targetAppVersion: "1.0",
          id: "01957b63-7d11-7281-b8e7-1120ccfdb8ab",
        },
      ];

      await setupBundles(bundles);

      const update = await fetchUpdateInfo({
        appVersion: "1.0",
        bundleId: "01957b63-7d11-7281-b8e7-1120ccfdb8ab",
        platform: "ios",
        minBundleId: "01957bb4-b13c-7000-8000-000000000000",
        channel: "production",
        _updateStrategy: "appVersion",
      });

      expect(update).toBeNull();
    });

    it("returns null when there are no bundles and minBundleId equals bundleId", async () => {
      await setupBundles([]);

      const update = await fetchUpdateInfo({
        appVersion: "1.0",
        bundleId: "0195d325-767a-7000-8000-000000000000",
        platform: "ios",
        minBundleId: "0195d325-767a-7000-8000-000000000000",
        channel: "production",
        _updateStrategy: "appVersion",
      });

      expect(update).toBeNull();
    });

    it("returns an update when a bundle is available despite minBundleId equals bundleId", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_APP_VERSION_STRATEGY,
          enabled: true,
          shouldForceUpdate: true,
          id: "01963024-c131-7971-8725-ab47e232df40",
          platform: "ios",
          targetAppVersion: "1.0.0",
        },
      ];

      await setupBundles(bundles);

      const update = await fetchUpdateInfo({
        appVersion: "1.0",
        bundleId: "00000000-0000-0000-0000-000000000000",
        platform: "ios",
        minBundleId: "00000000-0000-0000-0000-000000000000",
        channel: "production",
        _updateStrategy: "appVersion",
      });

      expect(update).toMatchObject({
        id: "01963024-c131-7971-8725-ab47e232df40",
        message: "hello",
        shouldForceUpdate: true,
        status: "UPDATE",
      });
    });
  });

  describe("fingerprint strategy", () => {
    it("returns null when no bundles are provided", async () => {
      await setupBundles([]);

      const update = await fetchUpdateInfo({
        fingerprintHash: "hash1",
        bundleId: NIL_UUID,
        platform: "ios",
        _updateStrategy: "fingerprint",
      });

      expect(update).toBeNull();
    });

    it("returns null when the app version does not qualify for the available higher version", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          fingerprintHash: "hash2",
          enabled: true,
          id: "00000000-0000-0000-0000-000000000001",
          shouldForceUpdate: false,
        },
      ];

      await setupBundles(bundles);

      const update = await fetchUpdateInfo({
        fingerprintHash: "hash1",
        bundleId: NIL_UUID,
        platform: "ios",
        _updateStrategy: "fingerprint",
      });

      expect(update).toBeNull();
    });

    it("tests target app version compatibility with available higher version", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          fingerprintHash: "hash1",
          enabled: true,
          id: "01963024-c131-7971-8725-ab47e232df41",
          shouldForceUpdate: false,
        },
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          fingerprintHash: "hash2",
          enabled: true,
          id: "01963024-c131-7971-8725-ab47e232df42",
          shouldForceUpdate: false,
        },
      ];

      await setupBundles(bundles);

      const update = await fetchUpdateInfo({
        fingerprintHash: "hash1",
        bundleId: "01963024-c131-7971-8725-ab47e232df41",
        platform: "ios",
        _updateStrategy: "fingerprint",
      });

      expect(update).toBeNull();
    });

    it("applies an update when a higher semver-compatible bundle is available", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          fingerprintHash: "hash1",
          enabled: true,
          id: "00000000-0000-0000-0000-000000000001",
          shouldForceUpdate: false,
        },
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          fingerprintHash: "hash2",
          enabled: true,
          id: "00000000-0000-0000-0000-000000000002",
          shouldForceUpdate: false,
        },
      ];

      await setupBundles(bundles);

      const update = await fetchUpdateInfo({
        fingerprintHash: "hash1",
        bundleId: NIL_UUID,
        platform: "ios",
        _updateStrategy: "fingerprint",
      });

      expect(update).toMatchObject({
        id: "00000000-0000-0000-0000-000000000001",
        shouldForceUpdate: false,
        status: "UPDATE",
        message: "hello",
      });
    });

    it("applies an update if shouldForceUpdate is true for a matching version", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          fingerprintHash: "hash1",
          enabled: true,
          id: "00000000-0000-0000-0000-000000000001",
          shouldForceUpdate: true,
        },
      ];

      await setupBundles(bundles);

      const update = await fetchUpdateInfo({
        fingerprintHash: "hash1",
        bundleId: NIL_UUID,
        platform: "ios",
        _updateStrategy: "fingerprint",
      });

      expect(update).toMatchObject({
        id: "00000000-0000-0000-0000-000000000001",
        shouldForceUpdate: true,
        status: "UPDATE",
        message: "hello",
      });
    });

    it("applies an update for a matching version even if shouldForceUpdate is false", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          fingerprintHash: "hash1",
          enabled: true,
          id: "00000000-0000-0000-0000-000000000001",
          shouldForceUpdate: false,
        },
      ];

      await setupBundles(bundles);

      const update = await fetchUpdateInfo({
        fingerprintHash: "hash1",
        bundleId: NIL_UUID,
        platform: "ios",
        _updateStrategy: "fingerprint",
      });

      expect(update).toMatchObject({
        id: "00000000-0000-0000-0000-000000000001",
        shouldForceUpdate: false,
        status: "UPDATE",
        message: "hello",
      });
    });

    it("applies an update when the app version is the same but the bundle is still considered higher", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          fingerprintHash: "hash1",
          shouldForceUpdate: false,
          enabled: true,
          id: "00000000-0000-0000-0000-000000000005",
        },
      ];

      await setupBundles(bundles);

      const update = await fetchUpdateInfo({
        fingerprintHash: "hash1",
        bundleId: NIL_UUID,
        platform: "ios",
        _updateStrategy: "fingerprint",
      });

      expect(update).toMatchObject({
        id: "00000000-0000-0000-0000-000000000005",
        shouldForceUpdate: false,
        message: "hello",
        status: "UPDATE",
      });
    });

    it("falls back to an older enabled bundle when the latest is disabled", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          fingerprintHash: "hash1",
          shouldForceUpdate: true,
          enabled: false,
          id: "00000000-0000-0000-0000-000000000002",
        },
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          fingerprintHash: "hash1",
          shouldForceUpdate: false,
          enabled: true,
          id: "00000000-0000-0000-0000-000000000001",
        },
      ];

      await setupBundles(bundles);

      const update = await fetchUpdateInfo({
        fingerprintHash: "hash1",
        bundleId: NIL_UUID,
        platform: "ios",
        _updateStrategy: "fingerprint",
      });

      expect(update).toMatchObject({
        message: "hello",
        id: "00000000-0000-0000-0000-000000000001",
        shouldForceUpdate: false,
        status: "UPDATE",
      });
    });

    it("returns null if all bundles are disabled", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          fingerprintHash: "hash1",
          shouldForceUpdate: true,
          enabled: false,
          id: "00000000-0000-0000-0000-000000000002",
        },
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          fingerprintHash: "hash1",
          shouldForceUpdate: false,
          enabled: false,
          id: "00000000-0000-0000-0000-000000000001",
        },
      ];

      await setupBundles(bundles);

      const update = await fetchUpdateInfo({
        fingerprintHash: "hash1",
        bundleId: NIL_UUID,
        platform: "ios",
        _updateStrategy: "fingerprint",
      });

      expect(update).toBeNull();
    });

    it("triggers a rollback if the latest bundle is disabled and no other updates are enabled", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          fingerprintHash: "hash1",
          shouldForceUpdate: true,
          enabled: false,
          id: "00000000-0000-0000-0000-000000000002",
        },
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          fingerprintHash: "hash1",
          shouldForceUpdate: false,
          enabled: false,
          id: "00000000-0000-0000-0000-000000000001",
        },
      ];

      await setupBundles(bundles);

      const update = await fetchUpdateInfo({
        fingerprintHash: "hash1",
        bundleId: NIL_UUID,
        platform: "ios",
        _updateStrategy: "fingerprint",
      });

      expect(update).toStrictEqual(null);
    });

    it("applies an update when a same-version bundle is available and enabled", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          shouldForceUpdate: false,
          fileHash:
            "a5cbf59a627759a88d472c502423ff55a4f6cd1aafeed3536f6a5f6e870c2290",
          message: "hi",
          fingerprintHash: "hash1",
          id: "00000000-0000-0000-0000-000000000001",
          enabled: true,
        },
      ];

      await setupBundles(bundles);

      const update = await fetchUpdateInfo({
        fingerprintHash: "hash1",
        bundleId: NIL_UUID,
        platform: "ios",
        _updateStrategy: "fingerprint",
      });

      expect(update).toMatchObject({
        id: "00000000-0000-0000-0000-000000000001",
        shouldForceUpdate: false,
        status: "UPDATE",
        message: "hi",
      });
    });

    it("forces a rollback if no matching bundle exists for the provided bundleId", async () => {
      await setupBundles([]);

      const update = await fetchUpdateInfo({
        appVersion: "1.0",
        bundleId: "00000000-0000-0000-0000-000000000002",
        platform: "ios",
        _updateStrategy: "appVersion",
      });

      expect(update).toMatchObject(INIT_BUNDLE_ROLLBACK_UPDATE_INFO);
    });

    it("returns null if the user is already up-to-date with an available bundle", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          fingerprintHash: "hash1",
          shouldForceUpdate: false,
          enabled: true,
          id: "00000000-0000-0000-0000-000000000002",
        },
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          fingerprintHash: "hash1",
          shouldForceUpdate: false,
          enabled: true,
          id: "00000000-0000-0000-0000-000000000001",
        },
      ];

      await setupBundles(bundles);

      const update = await fetchUpdateInfo({
        fingerprintHash: "hash1",
        bundleId: "00000000-0000-0000-0000-000000000002",
        platform: "ios",
        _updateStrategy: "fingerprint",
      });

      expect(update).toBeNull();
    });

    it("triggers a rollback if the previously used bundle no longer exists", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          fingerprintHash: "hash1",
          shouldForceUpdate: false,
          enabled: true,
          id: "00000000-0000-0000-0000-000000000001",
        },
      ];

      await setupBundles(bundles);

      const update = await fetchUpdateInfo({
        fingerprintHash: "hash1",
        bundleId: "00000000-0000-0000-0000-000000000002",
        platform: "ios",
        _updateStrategy: "fingerprint",
      });

      expect(update).toMatchObject({
        message: "hello",
        id: "00000000-0000-0000-0000-000000000001",
        shouldForceUpdate: true,
        status: "ROLLBACK",
      });
    });

    it("selects the next available bundle even if shouldForceUpdate is false", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          fingerprintHash: "hash1",
          shouldForceUpdate: false,
          enabled: true,
          id: "00000000-0000-0000-0000-000000000003",
        },
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          fingerprintHash: "hash1",
          shouldForceUpdate: false,
          enabled: true,
          id: "00000000-0000-0000-0000-000000000002",
        },
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          fingerprintHash: "hash1",
          shouldForceUpdate: false,
          enabled: true,
          id: "00000000-0000-0000-0000-000000000001",
        },
      ];

      await setupBundles(bundles);

      const update = await fetchUpdateInfo({
        fingerprintHash: "hash1",
        bundleId: "00000000-0000-0000-0000-000000000002",
        platform: "ios",
        _updateStrategy: "fingerprint",
      });

      expect(update).toMatchObject({
        message: "hello",
        id: "00000000-0000-0000-0000-000000000003",
        shouldForceUpdate: false,
        status: "UPDATE",
      });
    });

    it("applies the highest available bundle even if the app version is unchanged", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          fingerprintHash: "hash1",
          shouldForceUpdate: false,
          enabled: true,
          id: "00000000-0000-0000-0000-000000000005",
        },
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          fingerprintHash: "hash1",
          shouldForceUpdate: false,
          enabled: true,
          id: "00000000-0000-0000-0000-000000000004",
        },
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          fingerprintHash: "hash1",
          shouldForceUpdate: false,
          enabled: true,
          id: "00000000-0000-0000-0000-000000000003",
        },
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          fingerprintHash: "hash1",
          shouldForceUpdate: false,
          enabled: true,
          id: "00000000-0000-0000-0000-000000000002",
        },
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          fingerprintHash: "hash1",
          shouldForceUpdate: false,
          enabled: true,
          id: "00000000-0000-0000-0000-000000000001",
        },
      ];

      await setupBundles(bundles);

      const update = await fetchUpdateInfo({
        fingerprintHash: "hash1",
        bundleId: "00000000-0000-0000-0000-000000000002",
        platform: "ios",
        _updateStrategy: "fingerprint",
      });

      expect(update).toMatchObject({
        message: "hello",
        id: "00000000-0000-0000-0000-000000000005",
        shouldForceUpdate: false,
        status: "UPDATE",
      });
    });

    it("returns null if the newest matching bundle is disabled", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          fingerprintHash: "hash1",
          shouldForceUpdate: true,
          enabled: false,
          id: "00000000-0000-0000-0000-000000000003",
        },
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          fingerprintHash: "hash1",
          shouldForceUpdate: true,
          enabled: true,
          id: "00000000-0000-0000-0000-000000000002",
        },
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          fingerprintHash: "hash1",
          shouldForceUpdate: false,
          enabled: true,
          id: "00000000-0000-0000-0000-000000000001",
        },
      ];

      await setupBundles(bundles);

      const update = await fetchUpdateInfo({
        fingerprintHash: "hash1",
        bundleId: "00000000-0000-0000-0000-000000000002",
        platform: "ios",
        _updateStrategy: "fingerprint",
      });

      expect(update).toBeNull();
    });

    it("rolls back to an older enabled bundle if the current one is disabled", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          fingerprintHash: "hash1",
          shouldForceUpdate: true,
          enabled: false,
          id: "00000000-0000-0000-0000-000000000002",
        },
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          fingerprintHash: "hash1",
          shouldForceUpdate: false,
          enabled: true,
          id: "00000000-0000-0000-0000-000000000001",
        },
      ];

      await setupBundles(bundles);

      const update = await fetchUpdateInfo({
        fingerprintHash: "hash1",
        bundleId: "00000000-0000-0000-0000-000000000002",
        platform: "ios",
        _updateStrategy: "fingerprint",
      });

      expect(update).toMatchObject({
        message: "hello",
        id: "00000000-0000-0000-0000-000000000001",
        shouldForceUpdate: true,
        status: "ROLLBACK",
      });
    });

    it("rolls back to the original bundle when all available bundles are disabled", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          fingerprintHash: "hash1",
          shouldForceUpdate: true,
          enabled: false,
          id: "00000000-0000-0000-0000-000000000002",
        },
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          fingerprintHash: "hash1",
          shouldForceUpdate: false,
          enabled: false,
          id: "00000000-0000-0000-0000-000000000001",
        },
      ];

      await setupBundles(bundles);

      const update = await fetchUpdateInfo({
        fingerprintHash: "hash1",
        bundleId: "00000000-0000-0000-0000-000000000002",
        platform: "ios",
        _updateStrategy: "fingerprint",
      });

      expect(update).toMatchObject(INIT_BUNDLE_ROLLBACK_UPDATE_INFO);
    });

    it("returns null when there is an available bundle lower than minBundleId", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          fingerprintHash: "hash1",
          shouldForceUpdate: false,
          enabled: true,
          id: "0195715a-ce29-7c55-97d3-53af4fe369b7",
        },
      ];

      await setupBundles(bundles);

      const update = await fetchUpdateInfo({
        fingerprintHash: "hash1",
        minBundleId: "0195715b-9591-7000-8000-000000000000",
        bundleId: "0195715b-9591-7000-8000-000000000000",
        platform: "ios",
        _updateStrategy: "fingerprint",
      });

      expect(update).toBeNull();
    });

    it("returns the bundle when there is an available bundle higher than minBundleId", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          fingerprintHash: "hash1",
          shouldForceUpdate: false,
          enabled: true,
          id: "0195715d-42db-7475-9204-31819efc2f1d",
        },
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          fingerprintHash: "hash1",
          shouldForceUpdate: false,
          enabled: true,
          id: "0195715a-ce29-7c55-97d3-53af4fe369b7",
        },
      ];

      await setupBundles(bundles);

      const update = await fetchUpdateInfo({
        fingerprintHash: "hash1",
        minBundleId: "0195715b-9591-7000-8000-000000000000",
        bundleId: "0195715b-9591-7000-8000-000000000000",
        platform: "ios",
        _updateStrategy: "fingerprint",
      });

      expect(update).toMatchObject({
        id: "0195715d-42db-7475-9204-31819efc2f1d",
        message: "hello",
        shouldForceUpdate: false,
        status: "UPDATE",
      });
    });

    it("rolls back to initial bundle when current bundle is disabled and only bundles lower than minBundleId exist", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          fingerprintHash: "hash1",
          shouldForceUpdate: false,
          enabled: false,
          id: "0195715d-42db-7475-9204-31819efc2f1d",
        },
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          fingerprintHash: "hash1",
          shouldForceUpdate: false,
          enabled: true,
          id: "0195715a-ce29-7c55-97d3-53af4fe369b7",
        },
      ];

      await setupBundles(bundles);

      const update = await fetchUpdateInfo({
        fingerprintHash: "hash1",
        minBundleId: "0195715b-9591-7000-8000-000000000000",
        bundleId: "0195715d-42db-7475-9204-31819efc2f1d",
        platform: "ios",
        _updateStrategy: "fingerprint",
      });

      expect(update).toMatchObject(INIT_BUNDLE_ROLLBACK_UPDATE_INFO);
    });

    it("rolls back to initial bundle when current bundle does not exist and only bundles lower than minBundleId exist", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          fingerprintHash: "hash1",
          shouldForceUpdate: false,
          enabled: true,
          id: "0195715a-ce29-7c55-97d3-53af4fe369b7",
        },
      ];

      await setupBundles(bundles);

      const update = await fetchUpdateInfo({
        fingerprintHash: "hash1",
        minBundleId: "0195715b-9591-7000-8000-000000000000",
        bundleId: "0195715d-42db-7475-9204-31819efc2f1d",
        platform: "ios",
        _updateStrategy: "fingerprint",
      });

      expect(update).toMatchObject(INIT_BUNDLE_ROLLBACK_UPDATE_INFO);
    });

    it("returns null when current bundle is enabled and no updates are available", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          fingerprintHash: "hash1",
          shouldForceUpdate: false,
          enabled: true,
          id: "0195715d-42db-7475-9204-31819efc2f1d",
        },
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          fingerprintHash: "hash1",
          shouldForceUpdate: false,
          enabled: true,
          id: "0195715a-ce29-7c55-97d3-53af4fe369b7",
        },
      ];

      await setupBundles(bundles);

      const update = await fetchUpdateInfo({
        fingerprintHash: "hash1",
        minBundleId: "0195715b-9591-7000-8000-000000000000",
        bundleId: "0195715d-42db-7475-9204-31819efc2f1d",
        platform: "ios",
        _updateStrategy: "fingerprint",
      });

      expect(update).toBeNull();
    });

    it("rolls back when current bundle does not exist in DB and no bundles higher than minBundleId exist", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          fingerprintHash: "hash1",
          shouldForceUpdate: false,
          enabled: true,
          id: "01957165-bee7-7df3-a25d-6686f01b02ba",
        },
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          fingerprintHash: "hash1",
          shouldForceUpdate: false,
          enabled: true,
          id: "01957165-19fb-75af-a361-131c17a65ef2",
        },
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          fingerprintHash: "hash1",
          shouldForceUpdate: false,
          enabled: true,
          id: "01957164-fbc6-785f-98ce-a6ae459f6e4f",
        },
      ];

      await setupBundles(bundles);

      const update = await fetchUpdateInfo({
        fingerprintHash: "hash1",
        minBundleId: "01957166-6e63-7000-8000-000000000000",
        bundleId: "01957167-0389-7064-8d86-f8af7950daed",
        platform: "ios",
        _updateStrategy: "fingerprint",
      });

      expect(update).toMatchObject(INIT_BUNDLE_ROLLBACK_UPDATE_INFO);
    });

    it("rolls back to the bundle when current bundle does not exist in DB and a bundle exists that is higher than minBundleId but lower than current bundleId", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          fingerprintHash: "hash1",
          shouldForceUpdate: false,
          enabled: true,
          id: "0195716c-82f5-7e5e-ac8c-d4fbf5bc7555",
        },
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          fingerprintHash: "hash1",
          shouldForceUpdate: false,
          enabled: true,
          id: "01957167-0389-7064-8d86-f8af7950daed",
        },
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          fingerprintHash: "hash1",
          shouldForceUpdate: false,
          enabled: true,
          id: "01957165-bee7-7df3-a25d-6686f01b02ba",
        },
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          fingerprintHash: "hash1",
          shouldForceUpdate: false,
          enabled: true,
          id: "01957165-19fb-75af-a361-131c17a65ef2",
        },
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          fingerprintHash: "hash1",
          shouldForceUpdate: false,
          enabled: true,
          id: "01957164-fbc6-785f-98ce-a6ae459f6e4f",
        },
      ];

      await setupBundles(bundles);

      const update = await fetchUpdateInfo({
        fingerprintHash: "hash1",
        minBundleId: "01957166-6e63-7000-8000-000000000000",
        bundleId: "0195716c-d426-7308-9924-c3f8cb2eaaad",
        platform: "ios",
        _updateStrategy: "fingerprint",
      });

      expect(update).toMatchObject({
        id: "0195716c-82f5-7e5e-ac8c-d4fbf5bc7555",
        message: "hello",
        shouldForceUpdate: true,
        status: "ROLLBACK",
      });
    });

    it("returns null when installed bundle id exactly equals minBundleId and no newer bundle is available", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          fingerprintHash: "hash1",
          shouldForceUpdate: false,
          enabled: true,
          id: "01957179-d99d-7fbb-bc1e-feff6b3236f0",
        },
      ];

      await setupBundles(bundles);

      const update = await fetchUpdateInfo({
        fingerprintHash: "hash1",
        minBundleId: "0195715b-9591-7000-8000-000000000000",
        bundleId: "01957179-d99d-7fbb-bc1e-feff6b3236f0",
        platform: "ios",
        _updateStrategy: "fingerprint",
      });

      expect(update).toBeNull();
    });

    it("does not update bundles from different channels", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          fingerprintHash: "hash1",
          shouldForceUpdate: false,
          enabled: true,
          channel: "beta",
          id: "00000000-0000-0000-0000-000000000001",
        },
      ];

      await setupBundles(bundles);

      const update = await fetchUpdateInfo({
        fingerprintHash: "hash1",
        bundleId: NIL_UUID,
        platform: "ios",
        channel: "production",
        _updateStrategy: "fingerprint",
      });

      expect(update).toBeNull();
    });

    it("updates bundles from the same channel", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          fingerprintHash: "hash1",
          shouldForceUpdate: false,
          enabled: true,
          channel: "beta",
          id: "00000000-0000-0000-0000-000000000001",
        },
      ];

      await setupBundles(bundles);

      const update = await fetchUpdateInfo({
        fingerprintHash: "hash1",
        bundleId: NIL_UUID,
        platform: "ios",
        channel: "beta",
        _updateStrategy: "fingerprint",
      });

      expect(update).toMatchObject({
        id: "00000000-0000-0000-0000-000000000001",
        message: "hello",
        shouldForceUpdate: false,
        status: "UPDATE",
      });
    });

    it("returns null when minBundleId is greater than current bundle", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          fingerprintHash: "hash1",
          enabled: true,
          shouldForceUpdate: false,
          id: "01957b63-7d11-7281-b8e7-1120ccfdb8ab",
        },
      ];

      await setupBundles(bundles);

      const update = await fetchUpdateInfo({
        fingerprintHash: "hash1",
        bundleId: "01957b63-7d11-7281-b8e7-1120ccfdb8ab",
        platform: "ios",
        minBundleId: "01957bb4-b13c-7000-8000-000000000000",
        channel: "production",
        _updateStrategy: "fingerprint",
      });

      expect(update).toBeNull();
    });

    it("returns null when there are no bundles and minBundleId equals bundleId", async () => {
      await setupBundles([]);

      const update = await fetchUpdateInfo({
        fingerprintHash: "hash1",
        bundleId: "0195d325-767a-7000-8000-000000000000",
        platform: "ios",
        minBundleId: "0195d325-767a-7000-8000-000000000000",
        channel: "production",
        _updateStrategy: "fingerprint",
      });

      expect(update).toBeNull();
    });

    it("returns an update when a bundle is available despite minBundleId equals bundleId", async () => {
      const bundles: Bundle[] = [
        {
          ...DEFAULT_BUNDLE_FINGERPRINT_STRATEGY,
          enabled: true,
          shouldForceUpdate: true,
          id: "01963024-c131-7971-8725-ab47e232df40",
          platform: "ios",
          fingerprintHash: "hash1",
        },
      ];

      await setupBundles(bundles);

      const update = await fetchUpdateInfo({
        fingerprintHash: "hash1",
        bundleId: "00000000-0000-0000-0000-000000000000",
        platform: "ios",
        minBundleId: "00000000-0000-0000-0000-000000000000",
        channel: "production",
        _updateStrategy: "fingerprint",
      });

      expect(update).toMatchObject({
        id: "01963024-c131-7971-8725-ab47e232df40",
        message: "hello",
        shouldForceUpdate: true,
        status: "UPDATE",
      });
    });
  });
};
