// s3Database.spec.ts

import { CreateInvalidationCommand } from "@aws-sdk/client-cloudfront";
import {
  GetObjectCommand,
  ListObjectsV2Command,
  NoSuchKey,
  S3Client,
} from "@aws-sdk/client-s3";
import type { Bundle } from "@hot-updater/plugin-core";
import { Buffer } from "buffer";
import { Readable } from "stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { s3Database } from "./s3Database";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const DEFAULT_BUNDLE: Omit<
  Bundle,
  "id" | "platform" | "targetAppVersion" | "channel"
> = {
  fileHash: "hash",
  gitCommitHash: null,
  message: null,
  enabled: true,
  shouldForceUpdate: false,
  storageUri: "s3://test-bucket/test-key",
  fingerprintHash: null,
};

const createBundleJson = (
  channel: string,
  platform: "ios" | "android",
  targetAppVersion: string,
  id: string,
): Bundle => ({
  ...DEFAULT_BUNDLE,
  channel,
  id,
  platform,
  targetAppVersion,
});

const createBundleJsonFingerprint = (
  channel: string,
  platform: "ios" | "android",
  fingerprintHash: string,
  id: string,
): Bundle => ({
  ...DEFAULT_BUNDLE,
  channel,
  id,
  platform,
  fingerprintHash,
  targetAppVersion: null,
});

// fakeStore simulates files stored in S3
let fakeStore: Record<string, string> = {};
// 캐시 무효화 요청을 추적하기 위한 배열
let cloudfrontInvalidations: { paths: string[]; distributionId: string }[] = [];

vi.mock("@aws-sdk/lib-storage", () => {
  return {
    Upload: class {
      client: any;
      params: any;
      constructor({ client, params }: { client: any; params: any }) {
        this.client = client;
        this.params = params;
      }
      async done() {
        await delay(10);
        fakeStore[this.params.Key] = this.params.Body;
      }
    },
  };
});

vi.mock("@aws-sdk/client-cloudfront", async () => {
  const actual = await vi.importActual("@aws-sdk/client-cloudfront");
  return {
    ...actual,
    CloudFrontClient: class {
      send(command: any) {
        if (command instanceof CreateInvalidationCommand) {
          cloudfrontInvalidations.push({
            paths: command.input.InvalidationBatch?.Paths?.Items ?? [],
            distributionId: command.input.DistributionId ?? "",
          });
          return Promise.resolve({
            Invalidation: {
              Id: `invalidation-${Date.now()}`,
              Status: "InProgress",
            },
          });
        }
        return Promise.resolve({});
      }
    },
    CreateInvalidationCommand: actual.CreateInvalidationCommand,
  };
});

beforeEach(() => {
  fakeStore = {};
  cloudfrontInvalidations = [];
  vi.spyOn(S3Client.prototype, "send").mockImplementation(
    async (command: any) => {
      await delay(5);
      if (command instanceof ListObjectsV2Command) {
        const prefix = command.input.Prefix ?? "";
        const keys = Object.keys(fakeStore).filter((key) =>
          key.startsWith(prefix),
        );
        return {
          Contents: keys.map((key) => ({ Key: key })),
          NextContinuationToken: undefined,
        };
      }
      if (command instanceof GetObjectCommand) {
        const key = command.input.Key;
        if (key && fakeStore[key] !== undefined) {
          await delay(7);
          return { Body: Readable.from([Buffer.from(fakeStore[key])]) };
        }
        const error = new Error("NoSuchKey");
        Object.setPrototypeOf(error, NoSuchKey.prototype);
        throw error;
      }
      if (command.constructor.name === "DeleteObjectCommand") {
        const key = command.input.Key;
        await delay(10);
        delete fakeStore[key];
        return {};
      }
      throw new Error("Unsupported command in fake S3 client");
    },
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("s3Database plugin", () => {
  const bucketName = "test-bucket";
  const s3Config = {};
  let plugin = s3Database({
    bucketName,
    ...s3Config,
    cloudfrontDistributionId: "test-distribution-id",
  })();

  beforeEach(async () => {
    plugin = s3Database({
      bucketName,
      ...s3Config,
      cloudfrontDistributionId: "test-distribution-id",
    })();
  });

  it("should append a new bundle and commit to S3", async () => {
    // Create new bundle
    const bundleKey = "production/ios/1.0.0/update.json";
    const targetVersionsKey = "production/ios/target-app-versions.json";
    const newBundle = createBundleJson(
      "production",
      "ios",
      "1.0.0",
      "00000000-0000-0000-0000-000000000001",
    );

    // Add bundle and commit
    await plugin.appendBundle(newBundle);
    await plugin.commitBundle();

    // Verify bundle was properly added to update.json file
    const storedBundles = JSON.parse(fakeStore[bundleKey]);
    expect(storedBundles).toStrictEqual([newBundle]);

    // Verify new version was added to target-app-versions.json
    const versions = JSON.parse(fakeStore[targetVersionsKey]);
    expect(versions).toContain("1.0.0");

    // Verify bundle can be retrieved from memory cache
    const fetchedBundle = await plugin.getBundleById(
      "00000000-0000-0000-0000-000000000001",
    );
    expect(fetchedBundle).toStrictEqual(newBundle);
  });

  it("should update an existing bundle and reflect changes in S3", async () => {
    const bundleKey = "production/android/2.0.0/update.json";
    const targetVersionsKey = "production/android/target-app-versions.json";
    const initialBundle = createBundleJson(
      "production",
      "android",
      "2.0.0",
      "00000000-0000-0000-0000-000000000002",
    );

    // Pre-populate bundle data in fakeStore
    fakeStore[bundleKey] = JSON.stringify([initialBundle]);
    fakeStore[targetVersionsKey] = JSON.stringify(["2.0.0"]);

    // Update bundle and commit
    await plugin.getBundles({ limit: 20, offset: 0 });
    await plugin.updateBundle("00000000-0000-0000-0000-000000000002", {
      enabled: false,
    });
    await plugin.commitBundle();

    // Verify changes were reflected in update.json file
    const updatedBundles = JSON.parse(fakeStore[bundleKey]);
    expect(updatedBundles).toStrictEqual([
      {
        ...initialBundle,
        enabled: false,
      },
    ]);
  });

  it("should throw an error when trying to update a non-existent bundle", async () => {
    await expect(
      plugin.updateBundle("nonexistent", { enabled: true }),
    ).rejects.toThrow("targetBundleId not found");
  });

  it("should move a bundle from ios/1.x.x/update.json to ios/1.0.2/update.json when targetAppVersion is updated", async () => {
    const keyOld = "production/ios/1.x.x/update.json";
    const keyNew = "production/ios/1.0.2/update.json";
    const targetVersionsKey = "production/ios/target-app-versions.json";

    // Pre-populate bundle data in fakeStore
    const oldVersionBundles = [
      createBundleJson(
        "production",
        "ios",
        "1.x.x",
        "00000000-0000-0000-0000-000000000003",
      ),
      createBundleJson(
        "production",
        "ios",
        "1.x.x",
        "00000000-0000-0000-0000-000000000002",
      ),
      createBundleJson(
        "production",
        "ios",
        "1.x.x",
        "00000000-0000-0000-0000-000000000001",
      ),
    ];

    const newVersionBundles = [
      createBundleJson(
        "production",
        "ios",
        "1.0.2",
        "00000000-0000-0000-0000-000000000005",
      ),
      createBundleJson(
        "production",
        "ios",
        "1.0.2",
        "00000000-0000-0000-0000-000000000004",
      ),
    ];

    // Configure update.json files (_updateJsonKey is added internally during getBundles())
    fakeStore[keyOld] = JSON.stringify(oldVersionBundles);
    fakeStore[keyNew] = JSON.stringify(newVersionBundles);

    // Set initial state of target-app-versions.json
    fakeStore[targetVersionsKey] = JSON.stringify(["1.x.x", "1.0.2"]);

    // Load all bundle info from S3 into memory cache
    await plugin.getBundles({ limit: 20, offset: 0 });

    // Update targetAppVersion of one bundle from ios/1.x.x to 1.0.2
    await plugin.updateBundle("00000000-0000-0000-0000-000000000003", {
      targetAppVersion: "1.0.2",
    });
    // Commit changes to S3
    await plugin.commitBundle();

    // ios/1.0.2/update.json should have 3 bundles: 2 existing + 1 moved
    const newFileBundles = JSON.parse(fakeStore[keyNew]);
    expect(newFileBundles).toStrictEqual([
      createBundleJson(
        "production",
        "ios",
        "1.0.2",
        "00000000-0000-0000-0000-000000000005",
      ),
      createBundleJson(
        "production",
        "ios",
        "1.0.2",
        "00000000-0000-0000-0000-000000000004",
      ),
      createBundleJson(
        "production",
        "ios",
        "1.0.2",
        "00000000-0000-0000-0000-000000000003",
      ),
    ]);

    // And ios/1.x.x/update.json should have 2 remaining bundles
    const oldFileBundles = JSON.parse(fakeStore[keyOld]);
    expect(oldFileBundles).toStrictEqual([
      createBundleJson(
        "production",
        "ios",
        "1.x.x",
        "00000000-0000-0000-0000-000000000002",
      ),
      createBundleJson(
        "production",
        "ios",
        "1.x.x",
        "00000000-0000-0000-0000-000000000001",
      ),
    ]);

    // target-app-versions.json should have the new version
    const updatedVersions = JSON.parse(fakeStore[targetVersionsKey]);
    expect(updatedVersions).toStrictEqual(["1.x.x", "1.0.2"]);
  });

  it("should move all bundles from ios/1.0.2/update.json to ios/1.x.x/update.json when targetAppVersion is updated", async () => {
    const keyOld = "production/ios/1.x.x/update.json";
    const keyNew = "production/ios/1.0.2/update.json";
    const targetVersionsKey = "production/ios/target-app-versions.json";

    // Pre-populate bundle data in fakeStore
    const oldVersionBundles = [
      createBundleJson(
        "production",
        "ios",
        "1.x.x",
        "00000000-0000-0000-0000-000000000003",
      ),
      createBundleJson(
        "production",
        "ios",
        "1.x.x",
        "00000000-0000-0000-0000-000000000002",
      ),
      createBundleJson(
        "production",
        "ios",
        "1.x.x",
        "00000000-0000-0000-0000-000000000001",
      ),
    ];

    const newVersionBundles = [
      createBundleJson(
        "production",
        "ios",
        "1.0.2",
        "00000000-0000-0000-0000-000000000005",
      ),
      createBundleJson(
        "production",
        "ios",
        "1.0.2",
        "00000000-0000-0000-0000-000000000004",
      ),
    ];

    // Configure update.json files (_updateJsonKey is added internally during getBundles())
    fakeStore[keyOld] = JSON.stringify(oldVersionBundles);
    fakeStore[keyNew] = JSON.stringify(newVersionBundles);

    // Set initial state of target-app-versions.json
    fakeStore[targetVersionsKey] = JSON.stringify(["1.x.x", "1.0.2"]);

    await plugin.getBundles({ limit: 20, offset: 0 });

    await plugin.updateBundle("00000000-0000-0000-0000-000000000004", {
      targetAppVersion: "1.x.x",
    });

    await plugin.updateBundle("00000000-0000-0000-0000-000000000005", {
      targetAppVersion: "1.x.x",
    });
    // Commit changes to S3
    await plugin.commitBundle();

    // ios/1.0.2/update.json file should not exist
    expect(fakeStore[keyNew]).toBeUndefined();

    // And ios/1.x.x/update.json should have all bundles
    const oldFileBundles = JSON.parse(fakeStore[keyOld]);
    expect(oldFileBundles).toStrictEqual([
      createBundleJson(
        "production",
        "ios",
        "1.x.x",
        "00000000-0000-0000-0000-000000000005",
      ),
      createBundleJson(
        "production",
        "ios",
        "1.x.x",
        "00000000-0000-0000-0000-000000000004",
      ),
      createBundleJson(
        "production",
        "ios",
        "1.x.x",
        "00000000-0000-0000-0000-000000000003",
      ),
      createBundleJson(
        "production",
        "ios",
        "1.x.x",
        "00000000-0000-0000-0000-000000000002",
      ),
      createBundleJson(
        "production",
        "ios",
        "1.x.x",
        "00000000-0000-0000-0000-000000000001",
      ),
    ]);

    // target-app-versions.json should be updated
    const updatedVersions = JSON.parse(fakeStore[targetVersionsKey]);
    expect(updatedVersions).toStrictEqual(["1.x.x"]);
  });

  it("should gather bundles from multiple update.json paths across different platforms", async () => {
    // Arrange: Configure different bundle data in multiple update.json files
    const iosBundle1 = createBundleJson(
      "production",
      "ios",
      "1.0.0",
      "bundle-ios-1",
    );
    const iosBundle2 = createBundleJson(
      "production",
      "ios",
      "2.0.0",
      "bundle-ios-2",
    );
    const androidBundle1 = createBundleJson(
      "production",
      "android",
      "1.0.0",
      "bundle-android-1",
    );

    // Valid update.json files
    fakeStore["production/ios/1.0.0/update.json"] = JSON.stringify([
      iosBundle1,
    ]);
    fakeStore["production/ios/2.0.0/update.json"] = JSON.stringify([
      iosBundle2,
    ]);
    fakeStore["production/android/1.0.0/update.json"] = JSON.stringify([
      androidBundle1,
    ]);

    // Invalid files: don't match pattern (should be ignored)
    fakeStore["production/ios/other.json"] = JSON.stringify([]);
    fakeStore["production/android/1.0.0/extra/update.json"] = JSON.stringify([
      createBundleJson(
        "production",
        "android",
        "1.0.0",
        "should-not-be-included",
      ),
    ]);

    // Act: Force reload bundle info from S3
    const bundles = await plugin.getBundles({ limit: 20, offset: 0 });

    // Assert: Returned bundle list should only include valid bundles
    expect(bundles.data).toHaveLength(3);
    expect(bundles.data).toEqual(
      expect.arrayContaining([iosBundle1, iosBundle2, androidBundle1]),
    );
  });

  it("should handle bundles from multiple channels correctly", async () => {
    // Arrange: Configure bundle data across different channels
    const productionIosBundle = createBundleJson(
      "production",
      "ios",
      "1.0.0",
      "prod-ios-1",
    );
    const betaIosBundle = createBundleJson(
      "beta",
      "ios",
      "1.0.0",
      "beta-ios-1",
    );
    const alphaIosBundle = createBundleJson(
      "alpha",
      "ios",
      "1.0.0",
      "alpha-ios-1",
    );
    const productionAndroidBundle = createBundleJson(
      "production",
      "android",
      "1.0.0",
      "prod-android-1",
    );
    const betaAndroidBundle = createBundleJson(
      "beta",
      "android",
      "1.0.0",
      "beta-android-1",
    );

    // Set up update.json files for different channels
    fakeStore["production/ios/1.0.0/update.json"] = JSON.stringify([
      productionIosBundle,
    ]);
    fakeStore["beta/ios/1.0.0/update.json"] = JSON.stringify([betaIosBundle]);
    fakeStore["alpha/ios/1.0.0/update.json"] = JSON.stringify([alphaIosBundle]);
    fakeStore["production/android/1.0.0/update.json"] = JSON.stringify([
      productionAndroidBundle,
    ]);
    fakeStore["beta/android/1.0.0/update.json"] = JSON.stringify([
      betaAndroidBundle,
    ]);

    // Set up target-app-versions.json files for different channels
    fakeStore["production/ios/target-app-versions.json"] = JSON.stringify([
      "1.0.0",
    ]);
    fakeStore["beta/ios/target-app-versions.json"] = JSON.stringify(["1.0.0"]);
    fakeStore["alpha/ios/target-app-versions.json"] = JSON.stringify(["1.0.0"]);
    fakeStore["production/android/target-app-versions.json"] = JSON.stringify([
      "1.0.0",
    ]);
    fakeStore["beta/android/target-app-versions.json"] = JSON.stringify([
      "1.0.0",
    ]);

    // Act: Load all bundles from S3
    const bundles = await plugin.getBundles({ limit: 20, offset: 0 });

    // Assert: All bundles from all channels should be loaded
    expect(bundles.data).toHaveLength(5);
    expect(bundles.data).toEqual(
      expect.arrayContaining([
        productionIosBundle,
        betaIosBundle,
        alphaIosBundle,
        productionAndroidBundle,
        betaAndroidBundle,
      ]),
    );

    // Test updating a bundle in a specific channel
    await plugin.updateBundle("beta-ios-1", {
      enabled: false,
      message: "Disabled in beta channel",
    });
    await plugin.commitBundle();

    // Verify only the beta channel bundle was updated
    const updatedBetaIosBundles = JSON.parse(
      fakeStore["beta/ios/1.0.0/update.json"],
    );
    expect(updatedBetaIosBundles[0].enabled).toBe(false);
    expect(updatedBetaIosBundles[0].message).toBe("Disabled in beta channel");

    // Verify other channel bundles remain unchanged
    const productionIosBundles = JSON.parse(
      fakeStore["production/ios/1.0.0/update.json"],
    );
    expect(productionIosBundles[0].enabled).toBe(true);
  });

  it("should move a bundle between channels correctly", async () => {
    // Arrange: Set up bundles in different channels
    const betaIosBundle = createBundleJson(
      "beta",
      "ios",
      "1.0.0",
      "channel-move-test",
    );

    fakeStore["beta/ios/1.0.0/update.json"] = JSON.stringify([betaIosBundle]);
    fakeStore["beta/ios/target-app-versions.json"] = JSON.stringify(["1.0.0"]);
    fakeStore["production/ios/target-app-versions.json"] = JSON.stringify([
      "1.0.0",
    ]);

    // Act: Load bundles, update channel, and commit
    await plugin.getBundles({ limit: 20, offset: 0 });
    await plugin.updateBundle("channel-move-test", {
      channel: "production",
    });
    await plugin.commitBundle();

    // Assert: Bundle should be moved to production channel
    const productionBundles = JSON.parse(
      fakeStore["production/ios/1.0.0/update.json"],
    );
    expect(productionBundles).toHaveLength(1);
    expect(productionBundles[0].id).toBe("channel-move-test");
    expect(productionBundles[0].channel).toBe("production");

    // Beta channel should no longer have the bundle
    const betaBundles = JSON.parse(
      fakeStore["beta/ios/1.0.0/update.json"] || "[]",
    );
    expect(betaBundles).toHaveLength(0);
  });

  it("should return null for non-existent bundle id", async () => {
    // Verify null is returned for non-existent bundle ID
    const bundle = await plugin.getBundleById("non-existent-id");
    expect(bundle).toBeNull();
  });

  it("should return correct pagination info for single page", async () => {
    const bundle1 = {
      id: "bundle1",
      channel: "production",
      enabled: true,
      shouldForceUpdate: true,
      fileHash: "hash1",
      gitCommitHash: "commit1",
      message: "bundle 1",
      platform: "android",
      targetAppVersion: "2.0.0",
      storageUri: "gs://test-bucket/test-key",
      fingerprintHash: null,
    } as const;

    const bundle2 = {
      id: "bundle2",
      channel: "production",
      enabled: false,
      shouldForceUpdate: false,
      fileHash: "hash2",
      gitCommitHash: "commit2",
      message: "bundle 2",
      platform: "ios",
      targetAppVersion: "1.0.0",
      storageUri: "gs://test-bucket/test-key",
      fingerprintHash: null,
    } as const;

    const bundle3 = {
      id: "bundle3",
      channel: "staging",
      enabled: true,
      shouldForceUpdate: false,
      fileHash: "hash3",
      gitCommitHash: "commit3",
      message: "bundle 3",
      platform: "android",
      targetAppVersion: "1.5.0",
      storageUri: "gs://test-bucket/test-key",
      fingerprintHash: null,
    } as const;

    await plugin.appendBundle(bundle1);
    await plugin.appendBundle(bundle2);
    await plugin.appendBundle(bundle3);
    await plugin.commitBundle();

    const result = await plugin.getBundles({
      where: { channel: "production" },
      limit: 20,
      offset: 0,
    });

    expect(result.data).toHaveLength(2);
    expect(result.data[0].id).toBe("bundle2");
    expect(result.data[1].id).toBe("bundle1");

    expect(result.pagination).toEqual({
      total: 2,
      hasNextPage: false,
      hasPreviousPage: false,
      currentPage: 1,
      totalPages: 1,
    });
  });

  it("should return correct pagination info for multiple pages", async () => {
    const bundle1 = {
      id: "bundle1",
      channel: "production",
      enabled: true,
      shouldForceUpdate: true,
      fileHash: "hash1",
      gitCommitHash: "commit1",
      message: "bundle 1",
      platform: "android",
      targetAppVersion: "2.0.0",
      storageUri: "gs://test-bucket/test-key",
      fingerprintHash: null,
    } as const;

    const bundle2 = {
      id: "bundle2",
      channel: "production",
      enabled: false,
      shouldForceUpdate: false,
      fileHash: "hash2",
      gitCommitHash: "commit2",
      message: "bundle 2",
      platform: "ios",
      targetAppVersion: "1.0.0",
      storageUri: "gs://test-bucket/test-key",
      fingerprintHash: null,
    } as const;

    const bundle3 = {
      id: "bundle3",
      channel: "production",
      enabled: true,
      shouldForceUpdate: false,
      fileHash: "hash3",
      gitCommitHash: "commit3",
      message: "bundle 3",
      platform: "android",
      targetAppVersion: "1.5.0",
      storageUri: "gs://test-bucket/test-key",
      fingerprintHash: null,
    } as const;

    await plugin.appendBundle(bundle1);
    await plugin.appendBundle(bundle2);
    await plugin.appendBundle(bundle3);
    await plugin.commitBundle();

    const firstPage = await plugin.getBundles({
      where: { channel: "production" },
      limit: 2,
      offset: 0,
    });

    expect(firstPage.data).toHaveLength(2);
    expect(firstPage.pagination).toEqual({
      total: 3,
      hasNextPage: true,
      hasPreviousPage: false,
      currentPage: 1,
      totalPages: 2,
    });

    const secondPage = await plugin.getBundles({
      where: { channel: "production" },
      limit: 2,
      offset: 2,
    });

    expect(secondPage.data).toHaveLength(1);
    expect(secondPage.pagination).toEqual({
      total: 3,
      hasNextPage: false,
      hasPreviousPage: true,
      currentPage: 2,
      totalPages: 2,
    });
  });

  it("should not modify update.json when no bundles are marked as changed", async () => {
    // Verify existing update.json file is preserved
    const updateKey = "production/ios/1.0.0/update.json";
    const iosBundle = createBundleJson(
      "production",
      "ios",
      "1.0.0",
      "bundle-1",
    );
    fakeStore[updateKey] = JSON.stringify([iosBundle]);
    // Pre-configure target-app-versions file
    const targetKey = "production/ios/target-app-versions.json";
    fakeStore[targetKey] = JSON.stringify(["1.0.0"]);

    // Call commitBundle but update.json should remain unchanged as no bundles were modified
    await plugin.commitBundle();

    expect(fakeStore[updateKey]).toBe(JSON.stringify([iosBundle]));
    expect(JSON.parse(fakeStore[targetKey])).toEqual(["1.0.0"]);
  });

  it("should call onDatabaseUpdated hook after commit", async () => {
    // Verify hooks.onDatabaseUpdated is called after commit
    const onDatabaseUpdated = vi.fn();
    const pluginWithHook = s3Database(
      {
        bucketName,
        ...s3Config,
        cloudfrontDistributionId: "test-distribution-id",
      },
      { onDatabaseUpdated },
    )({ cwd: "" });
    const bundle = createBundleJson("production", "ios", "1.0.0", "hook-test");
    await pluginWithHook.appendBundle(bundle);
    await pluginWithHook.commitBundle();
    expect(onDatabaseUpdated).toHaveBeenCalled();
  });

  it("should sort bundles in descending order based on id", async () => {
    // Verify bundles from multiple update.json files are sorted in descending order
    const bundleA = createBundleJson("production", "ios", "1.0.0", "A");
    const bundleB = createBundleJson("production", "ios", "1.0.0", "B");
    const bundleC = createBundleJson("production", "ios", "1.0.0", "C");
    // Intentionally store in mixed order in fakeStore
    fakeStore["production/ios/1.0.0/update.json"] = JSON.stringify([
      bundleB,
      bundleA,
    ]);
    fakeStore["production/ios/2.0.0/update.json"] = JSON.stringify([bundleC]);

    const bundles = await plugin.getBundles({ limit: 20, offset: 0 });

    // Descending order: "C" > "B" > "A"
    expect(bundles.data).toEqual([bundleC, bundleB, bundleA]);
  });

  it("should return a bundle without internal keys from getBundleById", async () => {
    // Verify internal management keys (_updateJsonKey, _oldUpdateJsonKey) are removed when fetching by getBundleById
    const bundle = createBundleJson(
      "production",
      "android",
      "2.0.0",
      "internal-test",
    );
    fakeStore["production/android/2.0.0/update.json"] = JSON.stringify([
      bundle,
    ]);
    await plugin.getBundles({ limit: 20, offset: 0 });
    const fetchedBundle = await plugin.getBundleById("internal-test");
    expect(fetchedBundle).not.toHaveProperty("_updateJsonKey");
    expect(fetchedBundle).not.toHaveProperty("_oldUpdateJsonKey");
    expect(fetchedBundle).toEqual(bundle);
  });

  it("should update a bundle without changing its updateJsonKey if platform and targetAppVersion remain unchanged", async () => {
    // Verify updateJsonKey remains unchanged if platform and targetAppVersion stay the same
    const bundle = createBundleJson(
      "production",
      "android",
      "2.0.0",
      "same-key-test",
    );
    await plugin.appendBundle(bundle);
    // Change only enabled property → path should remain the same
    await plugin.updateBundle("same-key-test", { enabled: false });
    await plugin.commitBundle();

    const updateKey = "production/android/2.0.0/update.json";
    const storedBundles = JSON.parse(fakeStore[updateKey]);
    expect(storedBundles).toEqual([
      {
        ...bundle,
        enabled: false,
      },
    ]);
  });

  it("should return an empty array when no update.json files exist in S3", async () => {
    // Verify empty array is returned when no update.json files exist in S3
    fakeStore = {}; // Initialize S3 store
    const bundles = await plugin.getBundles({ limit: 20, offset: 0 });
    expect(bundles.data).toEqual([]);
  });

  it("should append multiple bundles and commit them to the correct update.json files", async () => {
    // Verify multiple bundles are added to their respective platform/version paths
    const bundle1 = createBundleJson("production", "ios", "1.0.0", "multi-1");
    const bundle2 = createBundleJson(
      "production",
      "android",
      "2.0.0",
      "multi-2",
    );

    await plugin.appendBundle(bundle1);
    await plugin.appendBundle(bundle2);
    await plugin.commitBundle();

    const iosUpdateKey = "production/ios/1.0.0/update.json";
    const androidUpdateKey = "production/android/2.0.0/update.json";

    const iosBundles = JSON.parse(fakeStore[iosUpdateKey]);
    const androidBundles = JSON.parse(fakeStore[androidUpdateKey]);

    expect(iosBundles).toEqual([bundle1]);
    expect(androidBundles).toEqual([bundle2]);
  });

  it("should not update S3 until commitBundle is called", async () => {
    const bundleKey = "production/ios/1.0.0/update.json";
    const newBundle = createBundleJson(
      "production",
      "ios",
      "1.0.0",
      "00000000-0000-0000-0000-000000000010",
    );

    // Verify fakeStore is empty at start of test
    expect(Object.keys(fakeStore)).toHaveLength(0);

    // Call appendBundle: at this point, should only be stored in memory cache, not in S3 (fakeStore)
    await plugin.appendBundle(newBundle);

    // S3 should remain unchanged until commitBundle is called
    expect(Object.keys(fakeStore)).toHaveLength(0);

    // Now after calling commitBundle, update.json file should be created in S3 (fakeStore)
    await plugin.commitBundle();
    expect(Object.keys(fakeStore)).toContain(bundleKey);
  });

  it("should load bundles from both ios and android update.json files", async () => {
    // Arrange: Add bundles to both iOS and Android update.json files
    const [iosBundle, iosBundle2, androidBundle] = [
      createBundleJson(
        "production",
        "ios",
        "3.0.0",
        "00000000-0000-0000-0000-000000000010",
      ),
      createBundleJson(
        "production",
        "ios",
        "3.0.0",
        "00000000-0000-0000-0000-000000000012",
      ),
      createBundleJson(
        "production",
        "android",
        "3.0.0",
        "00000000-0000-0000-0000-000000000011",
      ),
    ];
    // Simulate existing files in S3
    fakeStore["production/ios/3.0.0/update.json"] = JSON.stringify([
      iosBundle,
      iosBundle2,
    ]);
    fakeStore["production/android/3.0.0/update.json"] = JSON.stringify([
      androidBundle,
    ]);

    // Set corresponding target-app-versions files
    fakeStore["production/ios/target-app-versions.json"] = JSON.stringify([
      "3.0.0",
    ]);
    fakeStore["production/android/target-app-versions.json"] = JSON.stringify([
      "3.0.0",
    ]);

    // Act: Load all bundles
    const bundles = await plugin.getBundles({
      limit: 10,
      offset: 0,
      where: {
        platform: undefined,
        channel: "production",
      },
    });

    // Assert: Both bundles should be loaded
    expect(bundles.data).toHaveLength(3);
    expect(bundles.data).toEqual([iosBundle2, androidBundle, iosBundle]);

    // Sanity check: getBundleById works for both
    const foundIos = await plugin.getBundleById(
      "00000000-0000-0000-0000-000000000010",
    );
    const foundAndroid = await plugin.getBundleById(
      "00000000-0000-0000-0000-000000000011",
    );
    expect(foundIos).toEqual(iosBundle);
    expect(foundAndroid).toEqual(androidBundle);
  });

  it("should trigger CloudFront invalidation on new bundle commit", async () => {
    const bundleKey = "production/ios/1.0.0/update.json";
    const targetVersionsKey = "production/ios/target-app-versions.json";
    const newBundle = createBundleJson(
      "production",
      "ios",
      "1.0.0",
      "cloudfront-new-test",
    );
    await plugin.appendBundle(newBundle);

    await plugin.commitBundle();

    expect(cloudfrontInvalidations.length).toBeGreaterThan(0);
    const invalidatedPaths = cloudfrontInvalidations.flatMap(
      (inv) => inv.paths,
    );
    expect(invalidatedPaths).toContain(`/${bundleKey}`);
    expect(invalidatedPaths).toContain(`/${targetVersionsKey}`);
    expect(invalidatedPaths).toContain(
      "/api/check-update/app-version/ios/1.0.0/production/*",
    );
  });

  it("should trigger CloudFront invalidation when a bundle is updated without key change", async () => {
    const bundleKey = "production/ios/1.0.0/update.json";
    const targetVersionsKey = "production/ios/target-app-versions.json";
    const bundle = createBundleJson(
      "production",
      "ios",
      "1.0.0",
      "cloudfront-update-test",
    );
    await plugin.appendBundle(bundle);
    await plugin.commitBundle();

    cloudfrontInvalidations = [];

    await plugin.updateBundle("cloudfront-update-test", { enabled: false });
    await plugin.commitBundle();

    const invalidatedPaths = cloudfrontInvalidations.flatMap(
      (inv) => inv.paths,
    );
    expect(invalidatedPaths).toContain(`/${bundleKey}`);
    expect(invalidatedPaths).not.toContain(`/${targetVersionsKey}`);
    expect(invalidatedPaths).toContain(
      "/api/check-update/app-version/ios/1.0.0/production/*",
    );
  });

  it("should not trigger CloudFront invalidation when commitBundle is called with no pending changes", async () => {
    cloudfrontInvalidations = [];

    await plugin.commitBundle();

    expect(cloudfrontInvalidations.length).toBe(0);
  });

  it("should trigger CloudFront invalidation for fingerprint path when bundle is updated", async () => {
    const bundleKey = "production/ios/abcdef000/update.json";
    const targetVersionsKey = "production/ios/target-app-versions.json";
    const bundle = createBundleJsonFingerprint(
      "production",
      "ios",
      "abcdef000",
      "fingerprint-test",
    );
    await plugin.appendBundle(bundle);
    await plugin.commitBundle();

    cloudfrontInvalidations = [];

    await plugin.updateBundle("fingerprint-test", { enabled: false });
    await plugin.commitBundle();

    const invalidatedPaths = cloudfrontInvalidations.flatMap(
      (inv) => inv.paths,
    );
    expect(invalidatedPaths).toContain(`/${bundleKey}`);
    expect(invalidatedPaths).not.toContain(`/${targetVersionsKey}`);
    expect(invalidatedPaths).toContain(
      "/api/check-update/fingerprint/ios/abcdef000/production/*",
    );
    expect(invalidatedPaths).not.toContain(
      "/api/check-update/app-version/ios/1.0.0/production/*",
    );
  });
});
