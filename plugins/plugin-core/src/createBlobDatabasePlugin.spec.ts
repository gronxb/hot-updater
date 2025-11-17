import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBlobDatabasePlugin } from "./createBlobDatabasePlugin";
import type { Bundle } from "./types";

const DEFAULT_BUNDLE: Omit<
  Bundle,
  "id" | "platform" | "targetAppVersion" | "channel"
> = {
  fileHash: "hash",
  gitCommitHash: null,
  message: null,
  enabled: true,
  shouldForceUpdate: false,
  storageUri:
    "storage://my-app/00000000-0000-0000-0000-000000000000/bundle.zip",
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

const bundlesData = [
  {
    id: "bundleX",
    channel: "production",
    enabled: true,
    shouldForceUpdate: false,
    fileHash: "hashX",
    gitCommitHash: "commitX",
    message: "Bundle X",
    platform: "ios",
    targetAppVersion: "1.1.1",
    storageUri: "gs://test-bucket/test-key",
    fingerprintHash: null,
  },
  {
    id: "bundleY",
    channel: "production",
    enabled: true,
    shouldForceUpdate: false,
    fileHash: "hashY",
    gitCommitHash: "commitY",
    message: "Bundle Y",
    platform: "android",
    targetAppVersion: "1.1.1",
    storageUri: "gs://test-bucket/test-key",
    fingerprintHash: null,
  },
  {
    id: "bundleZ",
    channel: "staging",
    enabled: true,
    shouldForceUpdate: false,
    fileHash: "hashZ",
    gitCommitHash: "commitZ",
    message: "Bundle Z",
    platform: "ios",
    targetAppVersion: "1.1.1",
    storageUri: "gs://test-bucket/test-key",
    fingerprintHash: null,
  },
] as const;

// fakeStore simulates files stored in S3
let fakeStore: Record<string, string> = {};
// 캐시 무효화 요청을 추적하기 위한 배열
let cloudfrontInvalidations: { paths: string[] }[] = [];

beforeEach(() => {
  fakeStore = {};
  cloudfrontInvalidations = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("blobDatabase plugin", () => {
  async function listObjects(_context: any, prefix: string): Promise<string[]> {
    const keys = Object.keys(fakeStore).filter((key) => key.startsWith(prefix));
    return keys;
  }

  async function loadObject<T>(_context: any, path: string): Promise<T | null> {
    const data = fakeStore[path];
    if (data) {
      return JSON.parse(data);
    }
    return null;
  }

  async function uploadObject<T>(
    _context: any,
    path: string,
    data: T,
  ): Promise<void> {
    fakeStore[path] = JSON.stringify(data);
  }

  async function deleteObject(_context: any, path: string): Promise<void> {
    delete fakeStore[path];
  }

  async function invalidatePaths(_context: any, paths: string[]) {
    cloudfrontInvalidations.push({ paths });
  }

  let plugin = createBlobDatabasePlugin({
    name: "blobDatabase",
    apiBasePath: "/api/check-update",
    getContext: () => ({}),
    listObjects,
    loadObject,
    uploadObject,
    deleteObject,
    invalidatePaths,
  })();

  beforeEach(async () => {
    plugin = createBlobDatabasePlugin({
      name: "blobDatabase",
      apiBasePath: "/api/check-update",
      getContext: () => ({}),
      listObjects,
      loadObject,
      uploadObject,
      deleteObject,
      invalidatePaths,
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

    const result = await plugin.getBundles({ limit: 20, offset: 0 });
    // Assert: Returned bundle list should only include valid bundles
    expect(result.data).toHaveLength(3);
    expect(result.data).toEqual(
      expect.arrayContaining([iosBundle1, iosBundle2, androidBundle1]),
    );
    expect(result.pagination).toEqual({
      total: 3,
      hasNextPage: false,
      hasPreviousPage: false,
      currentPage: 1,
      totalPages: 1,
    });
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
    const result = await plugin.getBundles({ limit: 20, offset: 0 });
    // Assert: All bundles from all channels should be loaded
    expect(result.data).toHaveLength(5);
    expect(result.data).toEqual(
      expect.arrayContaining([
        productionIosBundle,
        betaIosBundle,
        alphaIosBundle,
        productionAndroidBundle,
        betaAndroidBundle,
      ]),
    );
    expect(result.pagination).toEqual({
      total: 5,
      hasNextPage: false,
      hasPreviousPage: false,
      currentPage: 1,
      totalPages: 1,
    });

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

    const pluginWithHook = createBlobDatabasePlugin({
      name: "blobDatabase",
      apiBasePath: "/api/check-update",
      getContext: () => ({}),
      listObjects,
      loadObject,
      uploadObject,
      deleteObject,
      invalidatePaths,
      hooks: { onDatabaseUpdated },
    })();
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
    const result = await plugin.getBundles({ limit: 20, offset: 0 });
    // Descending order: "C" > "B" > "A"
    expect(result.data).toEqual([bundleC, bundleB, bundleA]);
    expect(result.pagination).toEqual({
      total: 3,
      hasNextPage: false,
      hasPreviousPage: false,
      currentPage: 1,
      totalPages: 1,
    });
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
    const result = await plugin.getBundles({ limit: 20, offset: 0 });
    expect(result.data).toEqual([]);
    expect(result.pagination).toEqual({
      total: 0,
      hasNextPage: false,
      hasPreviousPage: false,
      currentPage: 1,
      totalPages: 0,
    });
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
    const result = await plugin.getBundles({
      limit: 10,
      offset: 0,
      where: {
        platform: undefined,
        channel: "production",
      },
    });
    // Assert: Both bundles should be loaded
    expect(result.data).toHaveLength(3);
    expect(result.data).toEqual([iosBundle2, androidBundle, iosBundle]);
    expect(result.pagination).toEqual({
      total: 3,
      hasNextPage: false,
      hasPreviousPage: false,
      currentPage: 1,
      totalPages: 1,
    });

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
  });

  it("should not trigger CloudFront invalidation when commitBundle is called with no pending changes", async () => {
    cloudfrontInvalidations = [];

    await plugin.commitBundle();

    expect(cloudfrontInvalidations.length).toBe(0);
  });

  it("should delete bundle successfully and remove from storage", async () => {
    // Setup
    await plugin.appendBundle(bundlesData[0]);
    await plugin.appendBundle(bundlesData[1]);
    await plugin.commitBundle();

    // Verify bundle exists
    const bundleBeforeDeletion = await plugin.getBundleById("bundleX");
    expect(bundleBeforeDeletion).toBeTruthy();

    // Execute
    await plugin.deleteBundle(bundlesData[0]);
    await plugin.commitBundle();

    // Assert
    const bundleAfterDeletion = await plugin.getBundleById("bundleX");
    expect(bundleAfterDeletion).toBeNull();

    // Verify other bundle still exists
    const otherBundle = await plugin.getBundleById("bundleY");
    expect(otherBundle).toBeTruthy();
  });

  it("should delete entire update.json file when no bundles remain", async () => {
    // Setup
    await plugin.appendBundle(bundlesData[0]);
    await plugin.commitBundle();

    // Find the actual update.json key
    const updateJsonKeys = Object.keys(fakeStore).filter((key) =>
      key.includes("update.json"),
    );
    expect(updateJsonKeys.length).toBeGreaterThan(0);
    const updateJsonKey = updateJsonKeys[0];

    // Execute
    await plugin.deleteBundle(bundlesData[0]);
    await plugin.commitBundle();

    // Assert
    expect(fakeStore[updateJsonKey]).toBeUndefined();
  });

  it("should keep update.json file when other bundles remain", async () => {
    // Setup - create bundles in same platform/channel
    const bundle1 = { ...bundlesData[0], id: "bundleA" };
    const bundle2 = { ...bundlesData[0], id: "bundleB" };

    await plugin.appendBundle(bundle1);
    await plugin.appendBundle(bundle2);
    await plugin.commitBundle();

    // Find the actual update.json key
    const updateJsonKeys = Object.keys(fakeStore).filter((key) =>
      key.includes("update.json"),
    );
    expect(updateJsonKeys.length).toBeGreaterThan(0);
    const updateJsonKey = updateJsonKeys[0];

    // Execute
    await plugin.deleteBundle(bundle1);
    await plugin.commitBundle();

    // Assert
    expect(fakeStore[updateJsonKey]).toBeDefined();
    const remainingBundle = await plugin.getBundleById("bundleB");
    expect(remainingBundle).toBeTruthy();
  });

  it("should handle bundle with fingerprintHash for cache invalidation", async () => {
    // Setup
    const bundleWithFingerprint = {
      ...bundlesData[0],
      fingerprintHash: "fingerprint123",
    };
    await plugin.appendBundle(bundleWithFingerprint);
    await plugin.commitBundle();

    // Execute
    await plugin.deleteBundle(bundlesData[0]);
    await plugin.commitBundle();

    // Assert
    const invalidationPaths = cloudfrontInvalidations.flatMap(
      (inv) => inv.paths,
    );
    const fingerprintPath = invalidationPaths.find(
      (path) => path.includes("fingerprint") && path.includes("fingerprint123"),
    );
    expect(fingerprintPath).toBeDefined();
  });

  it("should sort remaining bundles after deletion", async () => {
    // Setup
    const bundle1 = { ...bundlesData[0], id: "bundleA" };
    const bundle2 = { ...bundlesData[0], id: "bundleB" };
    const bundle3 = { ...bundlesData[0], id: "bundleC" };

    await plugin.appendBundle(bundle1);
    await plugin.appendBundle(bundle2);
    await plugin.appendBundle(bundle3);
    await plugin.commitBundle();

    // Execute
    await plugin.deleteBundle(bundle2);
    await plugin.commitBundle();

    // Assert
    // Find the actual update.json key
    const updateJsonKeys = Object.keys(fakeStore).filter((key) =>
      key.includes("update.json"),
    );
    expect(updateJsonKeys.length).toBeGreaterThan(0);
    const updateJsonKey = updateJsonKeys[0];

    const remainingBundles = JSON.parse(fakeStore[updateJsonKey] || "[]");
    expect(remainingBundles).toHaveLength(2);
    expect(remainingBundles[0].id).toBe("bundleC"); // sorted desc
    expect(remainingBundles[1].id).toBe("bundleA");
  });

  it("should invalidate correct paths for targetAppVersion when fingerprintHash is null", async () => {
    // Setup
    const bundleToDelete = {
      ...bundlesData[0],
      fingerprintHash: null,
      targetAppVersion: "2.0.0",
    };
    await plugin.appendBundle(bundleToDelete);
    await plugin.commitBundle();

    // Execute
    await plugin.deleteBundle(bundlesData[0]);
    await plugin.commitBundle();

    // Assert
    const invalidationPaths = cloudfrontInvalidations.flatMap(
      (inv) => inv.paths,
    );
    const appVersionPath = invalidationPaths.find(
      (path) => path.includes("app-version") && path.includes("2.0.0"),
    );
    expect(appVersionPath).toBeDefined();
  });

  it("should invalidate multiple path types correctly", async () => {
    // Setup
    await plugin.appendBundle(bundlesData[0]);
    await plugin.commitBundle();

    // Execute
    await plugin.deleteBundle(bundlesData[0]);
    await plugin.commitBundle();

    // Assert
    const invalidationPaths = cloudfrontInvalidations.flatMap(
      (inv) => inv.paths,
    );

    // Should have update.json path
    const updateJsonPath = invalidationPaths.find((path) =>
      path.includes("update.json"),
    );
    expect(updateJsonPath).toBeDefined();

    // Should have app-version path
    const appVersionPath = invalidationPaths.find(
      (path) =>
        path.includes("app-version") &&
        path.includes("1.1.1") &&
        path.includes("production"),
    );
    expect(appVersionPath).toBeDefined();
  });

  it("should handle different platforms separately", async () => {
    // Setup
    await plugin.appendBundle(bundlesData[0]); // ios
    await plugin.appendBundle(bundlesData[1]); // android
    await plugin.commitBundle();

    // Execute - delete ios bundle
    await plugin.deleteBundle(bundlesData[0]);
    await plugin.commitBundle();

    // Assert - android bundle should remain unaffected
    const androidBundle = await plugin.getBundleById("bundleY");
    expect(androidBundle).toBeTruthy();
    expect(androidBundle?.platform).toBe("android");
  });

  it("should handle different channels separately", async () => {
    // Setup
    await plugin.appendBundle(bundlesData[0]); // production
    await plugin.appendBundle(bundlesData[2]); // staging
    await plugin.commitBundle();

    // Execute - delete production bundle
    await plugin.deleteBundle(bundlesData[0]);
    await plugin.commitBundle();

    // Assert - staging bundle should remain unaffected
    const stagingBundle = await plugin.getBundleById("bundleZ");
    expect(stagingBundle).toBeTruthy();
    expect(stagingBundle?.channel).toBe("staging");
  });

  it("should work with getBundles pagination", async () => {
    // Setup - create multiple bundles
    const bundle1 = { ...bundlesData[0], id: "bundle1" };
    const bundle2 = { ...bundlesData[0], id: "bundle2" };
    const bundle3 = { ...bundlesData[0], id: "bundle3" };

    await plugin.appendBundle(bundle1);
    await plugin.appendBundle(bundle2);
    await plugin.appendBundle(bundle3);
    await plugin.commitBundle();

    // Verify all bundles exist
    const bundlesBeforeDeletion = await plugin.getBundles({
      where: { platform: "ios", channel: "production" },
      limit: 10,
      offset: 0,
    });
    expect(bundlesBeforeDeletion.data).toHaveLength(3);

    // Execute
    await plugin.deleteBundle(bundle2);
    await plugin.commitBundle();

    // Assert
    const bundlesAfterDeletion = await plugin.getBundles({
      where: { platform: "ios", channel: "production" },
      limit: 10,
      offset: 0,
    });
    expect(bundlesAfterDeletion.data).toHaveLength(2);
    expect(bundlesAfterDeletion.data.some((b) => b.id === "bundle2")).toBe(
      false,
    );
  });

  it("should trigger cache invalidation for all relevant paths", async () => {
    // Setup
    await plugin.appendBundle(bundlesData[0]);
    await plugin.commitBundle();

    // Clear previous invalidations
    cloudfrontInvalidations.length = 0;

    // Execute
    await plugin.deleteBundle(bundlesData[0]);
    await plugin.commitBundle();

    // Assert
    expect(cloudfrontInvalidations.length).toBeGreaterThan(0);
    const allPaths = cloudfrontInvalidations.flatMap((inv) => inv.paths);

    // Should invalidate update.json
    expect(allPaths.some((path) => path.includes("update.json"))).toBe(true);

    // Should invalidate app-version or fingerprint path
    const hasAppVersionOrFingerprint = allPaths.some(
      (path) => path.includes("app-version") || path.includes("fingerprint"),
    );
    expect(hasAppVersionOrFingerprint).toBe(true);
  });

  it("should invalidate both old and new channel paths when channel is updated", async () => {
    // Setup
    const bundle = createBundleJson(
      "beta",
      "ios",
      "1.0.0",
      "channel-update-test",
    );
    await plugin.appendBundle(bundle);
    await plugin.commitBundle();

    // Clear previous invalidations
    cloudfrontInvalidations.length = 0;

    // Execute - update channel from beta to production
    await plugin.updateBundle("channel-update-test", {
      channel: "production",
    });
    await plugin.commitBundle();

    // Assert
    expect(cloudfrontInvalidations.length).toBeGreaterThan(0);
    const allPaths = cloudfrontInvalidations.flatMap((inv) => inv.paths);

    // Should invalidate both old and new channel paths
    const oldChannelPath = allPaths.find(
      (path) => path.includes("beta") && path.includes("update.json"),
    );
    const newChannelPath = allPaths.find(
      (path) => path.includes("production") && path.includes("update.json"),
    );

    expect(oldChannelPath).toBeDefined();
    expect(newChannelPath).toBeDefined();

    // Should invalidate both old and new channel target-app-versions paths
    const oldChannelVersionsPath = allPaths.find(
      (path) =>
        path.includes("beta") && path.includes("target-app-versions.json"),
    );
    const newChannelVersionsPath = allPaths.find(
      (path) =>
        path.includes("production") &&
        path.includes("target-app-versions.json"),
    );

    expect(oldChannelVersionsPath).toBeDefined();
    expect(newChannelVersionsPath).toBeDefined();
  });

  it("should invalidate both old and new channel fingerprint paths when channel is updated", async () => {
    // Setup
    const bundle = createBundleJson(
      "beta",
      "ios",
      "1.0.0",
      "fingerprint-channel-update-test",
    );
    bundle.fingerprintHash = "fingerprint-hash-123";
    bundle.targetAppVersion = null;
    await plugin.appendBundle(bundle);
    await plugin.commitBundle();

    // Clear previous invalidations
    cloudfrontInvalidations.length = 0;

    // Execute - update channel from beta to production
    await plugin.updateBundle("fingerprint-channel-update-test", {
      channel: "production",
    });
    await plugin.commitBundle();

    // Assert
    expect(cloudfrontInvalidations.length).toBeGreaterThan(0);
    const allPaths = cloudfrontInvalidations.flatMap((inv) => inv.paths);

    const expectedOldFingerprintPath = `/api/check-update/fingerprint/${bundle.platform}/${bundle.fingerprintHash}/beta/*`;
    const expectedNewFingerprintPath = `/api/check-update/fingerprint/${bundle.platform}/${bundle.fingerprintHash}/production/*`;

    expect(allPaths).toContain(expectedOldFingerprintPath);
    expect(allPaths).toContain(expectedNewFingerprintPath);
  });

  it("should invalidate both old and new channel app-version paths when channel is updated", async () => {
    // Setup
    const bundle = createBundleJson(
      "beta",
      "ios",
      "1.0.0",
      "app-version-channel-update-test",
    );
    bundle.fingerprintHash = null;
    bundle.targetAppVersion = "1.0.0";
    await plugin.appendBundle(bundle);
    await plugin.commitBundle();

    // Clear previous invalidations
    cloudfrontInvalidations.length = 0;

    // Execute - update channel from beta to production
    await plugin.updateBundle("app-version-channel-update-test", {
      channel: "production",
    });
    await plugin.commitBundle();

    // Assert
    expect(cloudfrontInvalidations.length).toBeGreaterThan(0);
    const allPaths = cloudfrontInvalidations.flatMap((inv) => inv.paths);

    const expectedOldAppVersionPath = `/api/check-update/app-version/${bundle.platform}/${bundle.targetAppVersion}/beta/*`;
    const expectedNewAppVersionPath = `/api/check-update/app-version/${bundle.platform}/${bundle.targetAppVersion}/production/*`;

    expect(allPaths).toContain(expectedOldAppVersionPath);
    expect(allPaths).toContain(expectedNewAppVersionPath);
  });

  it("should invalidate CloudFront paths for semver pattern when appending bundle", async () => {
    const newBundle = createBundleJson(
      "production",
      "ios",
      "3.0.x",
      "cloudfront-new-test",
    );

    // Clear previous invalidations
    cloudfrontInvalidations.length = 0;

    await plugin.appendBundle(newBundle);
    await plugin.commitBundle();

    const invalidatedPaths = cloudfrontInvalidations.flatMap(
      (inv) => inv.paths,
    );
    expect(invalidatedPaths).toContain("/api/check-update/app-version/ios/*");
  });

  it("should invalidate CloudFront paths for exact app version when appending bundle", async () => {
    const newBundle = createBundleJson(
      "production",
      "ios",
      "3.0.1",
      "cloudfront-new-test",
    );

    // Clear previous invalidations
    cloudfrontInvalidations.length = 0;

    await plugin.appendBundle(newBundle);
    await plugin.commitBundle();

    const invalidatedPaths = cloudfrontInvalidations.flatMap(
      (inv) => inv.paths,
    );
    console.log(invalidatedPaths);
    expect(invalidatedPaths).toContain(
      "/api/check-update/app-version/ios/3.0.1/production/*",
    );
  });

  it("should invalidate exact app version path when changing from semver to exact", async () => {
    // Initial: semver target app version
    const initialBundle = createBundleJson(
      "production",
      "ios",
      "3.0.x",
      "cloudfront-new-test",
    );

    // Clear previous invalidations and seed initial state
    cloudfrontInvalidations.length = 0;
    await plugin.appendBundle(initialBundle);
    await plugin.commitBundle();

    // Clear invalidations for the update scenario
    cloudfrontInvalidations.length = 0;

    // Update: change to an exact app version
    await plugin.updateBundle("cloudfront-new-test", {
      targetAppVersion: "3.0.1",
    });
    await plugin.commitBundle();

    const invalidatedPaths = cloudfrontInvalidations.flatMap(
      (inv) => inv.paths,
    );
    expect(invalidatedPaths).toContain(
      "/api/check-update/app-version/ios/3.0.1/production/*",
    );
  });

  it("should invalidate platform-wide app-version path when changing from exact to semver", async () => {
    // Initial: exact target app version
    const initialBundle = createBundleJson(
      "production",
      "ios",
      "3.0.1",
      "cloudfront-new-test",
    );

    // Clear previous invalidations and seed initial state
    cloudfrontInvalidations.length = 0;
    await plugin.appendBundle(initialBundle);
    await plugin.commitBundle();

    // Clear invalidations for the update scenario
    cloudfrontInvalidations.length = 0;

    // Update: change to a semver pattern
    await plugin.updateBundle("cloudfront-new-test", {
      targetAppVersion: "3.0.x",
    });
    await plugin.commitBundle();

    const invalidatedPaths = cloudfrontInvalidations.flatMap(
      (inv) => inv.paths,
    );
    expect(invalidatedPaths).toContain("/api/check-update/app-version/ios/*");
  });

  it("should invalidate CloudFront paths for semver pattern when appending bundle", async () => {
    const newBundle = createBundleJson(
      "production",
      "android",
      "3.0.x",
      "cloudfront-new-test",
    );

    // Clear previous invalidations
    cloudfrontInvalidations.length = 0;

    await plugin.appendBundle(newBundle);
    await plugin.commitBundle();

    const invalidatedPaths = cloudfrontInvalidations.flatMap(
      (inv) => inv.paths,
    );
    expect(invalidatedPaths).toContain(
      "/api/check-update/app-version/android/*",
    );
  });

  it("should invalidate CloudFront paths for exact app version when appending bundle", async () => {
    const newBundle = createBundleJson(
      "production",
      "android",
      "3.0.1",
      "cloudfront-new-test",
    );

    // Clear previous invalidations
    cloudfrontInvalidations.length = 0;

    await plugin.appendBundle(newBundle);
    await plugin.commitBundle();

    const invalidatedPaths = cloudfrontInvalidations.flatMap(
      (inv) => inv.paths,
    );
    console.log(invalidatedPaths);
    expect(invalidatedPaths).toContain(
      "/api/check-update/app-version/android/3.0.1/production/*",
    );
  });

  it("should invalidate exact app version path when changing from semver to exact", async () => {
    // Initial: semver target app version
    const initialBundle = createBundleJson(
      "production",
      "android",
      "3.0.x",
      "cloudfront-new-test",
    );

    // Clear previous invalidations and seed initial state
    cloudfrontInvalidations.length = 0;
    await plugin.appendBundle(initialBundle);
    await plugin.commitBundle();

    // Clear invalidations for the update scenario
    cloudfrontInvalidations.length = 0;

    // Update: change to an exact app version
    await plugin.updateBundle("cloudfront-new-test", {
      targetAppVersion: "3.0.1",
    });
    await plugin.commitBundle();

    const invalidatedPaths = cloudfrontInvalidations.flatMap(
      (inv) => inv.paths,
    );
    expect(invalidatedPaths).toContain(
      "/api/check-update/app-version/android/3.0.1/production/*",
    );
  });

  it("should invalidate platform-wide app-version path when changing from exact to semver", async () => {
    // Initial: exact target app version
    const initialBundle = createBundleJson(
      "production",
      "android",
      "3.0.1",
      "cloudfront-new-test",
    );

    // Clear previous invalidations and seed initial state
    cloudfrontInvalidations.length = 0;
    await plugin.appendBundle(initialBundle);
    await plugin.commitBundle();

    // Clear invalidations for the update scenario
    cloudfrontInvalidations.length = 0;

    // Update: change to a semver pattern
    await plugin.updateBundle("cloudfront-new-test", {
      targetAppVersion: "3.0.x",
    });
    await plugin.commitBundle();

    const invalidatedPaths = cloudfrontInvalidations.flatMap(
      (inv) => inv.paths,
    );
    expect(invalidatedPaths).toContain(
      "/api/check-update/app-version/android/*",
    );
  });

  it("should invalidate CloudFront paths for semver pattern when deleting bundle (ios)", async () => {
    const bundle = createBundleJson(
      "production",
      "ios",
      "3.0.x",
      "cloudfront-delete-semver-ios",
    );

    // Add bundle first
    await plugin.appendBundle(bundle);
    await plugin.commitBundle();

    // Clear previous invalidations
    cloudfrontInvalidations.length = 0;

    // Delete the bundle
    await plugin.deleteBundle(bundle);
    await plugin.commitBundle();

    const invalidatedPaths = cloudfrontInvalidations.flatMap(
      (inv) => inv.paths,
    );
    expect(invalidatedPaths).toContain("/api/check-update/app-version/ios/*");
  });

  it("should invalidate CloudFront paths for exact app version when deleting bundle (ios)", async () => {
    const bundle = createBundleJson(
      "production",
      "ios",
      "3.0.1",
      "cloudfront-delete-exact-ios",
    );

    // Add bundle first
    await plugin.appendBundle(bundle);
    await plugin.commitBundle();

    // Clear previous invalidations
    cloudfrontInvalidations.length = 0;

    // Delete the bundle
    await plugin.deleteBundle(bundle);
    await plugin.commitBundle();

    const invalidatedPaths = cloudfrontInvalidations.flatMap(
      (inv) => inv.paths,
    );
    expect(invalidatedPaths).toContain(
      "/api/check-update/app-version/ios/3.0.1/production/*",
    );
  });

  it("should invalidate CloudFront paths for semver pattern when deleting bundle (android)", async () => {
    const bundle = createBundleJson(
      "production",
      "android",
      "3.0.x",
      "cloudfront-delete-semver-android",
    );

    // Add bundle first
    await plugin.appendBundle(bundle);
    await plugin.commitBundle();

    // Clear previous invalidations
    cloudfrontInvalidations.length = 0;

    // Delete the bundle
    await plugin.deleteBundle(bundle);
    await plugin.commitBundle();

    const invalidatedPaths = cloudfrontInvalidations.flatMap(
      (inv) => inv.paths,
    );
    expect(invalidatedPaths).toContain(
      "/api/check-update/app-version/android/*",
    );
  });

  it("should invalidate CloudFront paths for exact app version when deleting bundle (android)", async () => {
    const bundle = createBundleJson(
      "production",
      "android",
      "3.0.1",
      "cloudfront-delete-exact-android",
    );

    // Add bundle first
    await plugin.appendBundle(bundle);
    await plugin.commitBundle();

    // Clear previous invalidations
    cloudfrontInvalidations.length = 0;

    // Delete the bundle
    await plugin.deleteBundle(bundle);
    await plugin.commitBundle();

    const invalidatedPaths = cloudfrontInvalidations.flatMap(
      (inv) => inv.paths,
    );
    expect(invalidatedPaths).toContain(
      "/api/check-update/app-version/android/3.0.1/production/*",
    );
  });

  it("should invalidate all normalized semver paths when targetAppVersion is 1.0.0", async () => {
    // Setup: Deploy bundle with targetAppVersion "1.0.0"
    const bundle = createBundleJson(
      "production",
      "ios",
      "1.0.0",
      "semver-normalization-test",
    );

    // Clear previous invalidations
    cloudfrontInvalidations.length = 0;

    await plugin.appendBundle(bundle);
    await plugin.commitBundle();

    const invalidatedPaths = cloudfrontInvalidations.flatMap(
      (inv) => inv.paths,
    );

    // Should invalidate exact version path
    expect(invalidatedPaths).toContain(
      "/api/check-update/app-version/ios/1.0.0/production/*",
    );

    // Should ALSO invalidate normalized versions
    // "1.0.0" should also invalidate "1.0" and "1"
    expect(invalidatedPaths).toContain(
      "/api/check-update/app-version/ios/1.0/production/*",
    );
    expect(invalidatedPaths).toContain(
      "/api/check-update/app-version/ios/1/production/*",
    );
  });

  it("should invalidate normalized semver paths when targetAppVersion is 2.1.0", async () => {
    // Setup: Deploy bundle with targetAppVersion "2.1.0"
    const bundle = createBundleJson(
      "production",
      "android",
      "2.1.0",
      "semver-normalization-test-2",
    );

    // Clear previous invalidations
    cloudfrontInvalidations.length = 0;

    await plugin.appendBundle(bundle);
    await plugin.commitBundle();

    const invalidatedPaths = cloudfrontInvalidations.flatMap(
      (inv) => inv.paths,
    );

    // Should invalidate exact version path
    expect(invalidatedPaths).toContain(
      "/api/check-update/app-version/android/2.1.0/production/*",
    );

    // Should ALSO invalidate "2.1" (patch is 0)
    expect(invalidatedPaths).toContain(
      "/api/check-update/app-version/android/2.1/production/*",
    );

    // Should NOT invalidate "2" (minor is not 0)
    expect(invalidatedPaths).not.toContain(
      "/api/check-update/app-version/android/2/production/*",
    );
  });

  it("should not add duplicate normalized paths when minor and patch are non-zero", async () => {
    // Setup: Deploy bundle with targetAppVersion "1.2.3"
    const bundle = createBundleJson(
      "production",
      "ios",
      "1.2.3",
      "no-normalization-test",
    );

    // Clear previous invalidations
    cloudfrontInvalidations.length = 0;

    await plugin.appendBundle(bundle);
    await plugin.commitBundle();

    const invalidatedPaths = cloudfrontInvalidations.flatMap(
      (inv) => inv.paths,
    );

    // Should only invalidate the exact version path
    expect(invalidatedPaths).toContain(
      "/api/check-update/app-version/ios/1.2.3/production/*",
    );

    // Should NOT invalidate normalized versions (minor/patch are non-zero)
    expect(invalidatedPaths).not.toContain(
      "/api/check-update/app-version/ios/1.2/production/*",
    );
    expect(invalidatedPaths).not.toContain(
      "/api/check-update/app-version/ios/1/production/*",
    );
  });

  describe("targetAppVersion with spaces (semver ranges)", () => {
    it("should normalize targetAppVersion with spaces when creating bundle", async () => {
      // Setup: Create bundle with targetAppVersion containing spaces
      const bundle = createBundleJson(
        "production",
        "ios",
        ">= 10.7.0",
        "space-normalization-test",
      );

      await plugin.appendBundle(bundle);
      await plugin.commitBundle();

      // Assert: Key should be created without spaces
      const normalizedKey = "production/ios/>=10.7.0/update.json";
      expect(fakeStore[normalizedKey]).toBeDefined();

      // Verify the bundle is stored correctly
      const storedBundles = JSON.parse(fakeStore[normalizedKey]);
      expect(storedBundles).toHaveLength(1);
      expect(storedBundles[0].id).toBe("space-normalization-test");
    });

    it("should normalize targetAppVersion with multiple spaces", async () => {
      // Test with extra spaces
      const bundle = createBundleJson(
        "production",
        "android",
        ">  1.0.0   <   2.0.0",
        "multi-space-test",
      );

      await plugin.appendBundle(bundle);
      await plugin.commitBundle();

      // Assert: Spaces within comparators should be removed, but space between
      // different comparators must be preserved for valid semver syntax
      const normalizedKey = "production/android/>1.0.0 <2.0.0/update.json";
      expect(fakeStore[normalizedKey]).toBeDefined();
    });

    it("should generate correct CloudFront invalidation paths for semver ranges with spaces", async () => {
      const bundle = createBundleJson(
        "production",
        "ios",
        ">= 10.7.0",
        "cloudfront-space-test",
      );

      cloudfrontInvalidations.length = 0;

      await plugin.appendBundle(bundle);
      await plugin.commitBundle();

      const invalidatedPaths = cloudfrontInvalidations.flatMap(
        (inv) => inv.paths,
      );

      // Should invalidate the normalized key (URI encoded: >= becomes %3E=)
      expect(invalidatedPaths).toContain(
        "/production/ios/%3E=10.7.0/update.json",
      );

      // Should invalidate app-version path (since it's not an exact version)
      expect(invalidatedPaths).toContain("/api/check-update/app-version/ios/*");
    });

    it("should handle update operation with space-containing targetAppVersion", async () => {
      // Initial: exact version
      const initialBundle = createBundleJson(
        "production",
        "ios",
        "1.0.0",
        "update-space-test",
      );

      await plugin.appendBundle(initialBundle);
      await plugin.commitBundle();

      cloudfrontInvalidations.length = 0;

      // Update to semver range with spaces
      await plugin.updateBundle("update-space-test", {
        targetAppVersion: "> 2.0.0",
      });
      await plugin.commitBundle();

      // Assert: Should move to normalized path
      const oldKey = "production/ios/1.0.0/update.json";
      const newKey = "production/ios/>2.0.0/update.json";

      expect(fakeStore[newKey]).toBeDefined();
      const newBundles = JSON.parse(fakeStore[newKey]);
      expect(newBundles[0].id).toBe("update-space-test");

      // Old key should be removed (no bundles left)
      expect(fakeStore[oldKey]).toBeUndefined();
    });

    it("should handle delete operation with space-containing targetAppVersion", async () => {
      const bundle = createBundleJson(
        "production",
        "android",
        "<= 5.0.0",
        "delete-space-test",
      );

      await plugin.appendBundle(bundle);
      await plugin.commitBundle();

      const bundleKey = "production/android/<=5.0.0/update.json";
      expect(fakeStore[bundleKey]).toBeDefined();

      cloudfrontInvalidations.length = 0;

      // Delete the bundle
      await plugin.deleteBundle(bundle);
      await plugin.commitBundle();

      // Assert: Bundle should be deleted
      expect(fakeStore[bundleKey]).toBeUndefined();

      // Should invalidate correct paths (URI encoded: <= becomes %3C=)
      const invalidatedPaths = cloudfrontInvalidations.flatMap(
        (inv) => inv.paths,
      );
      expect(invalidatedPaths).toContain(
        "/production/android/%3C=5.0.0/update.json",
      );
      expect(invalidatedPaths).toContain(
        "/api/check-update/app-version/android/*",
      );
    });

    it("should handle various semver range formats with spaces", async () => {
      const testCases = [
        { version: "> 1.0.0", normalized: ">1.0.0" },
        { version: "< 2.0.0", normalized: "<2.0.0" },
        { version: ">= 1.0.0", normalized: ">=1.0.0" },
        { version: "<= 2.0.0", normalized: "<=2.0.0" },
        { version: "~  1.0.0", normalized: "~1.0.0" },
        { version: "^  2.0.0", normalized: "^2.0.0" },
      ];

      for (const [index, { version }] of testCases.entries()) {
        const bundle = createBundleJson(
          "production",
          "ios",
          version,
          `format-test-${index}`,
        );

        await plugin.appendBundle(bundle);
      }

      await plugin.commitBundle();

      // Verify all bundles were stored with normalized keys
      for (const { normalized } of testCases) {
        const key = `production/ios/${normalized}/update.json`;
        expect(fakeStore[key]).toBeDefined();
      }
    });

    it("should handle getBundleById with space-containing targetAppVersion", async () => {
      const bundle = createBundleJson(
        "production",
        "ios",
        ">= 3.0.0",
        "getbyid-space-test",
      );

      await plugin.appendBundle(bundle);
      await plugin.commitBundle();

      // Should be able to retrieve the bundle by ID
      const fetchedBundle = await plugin.getBundleById("getbyid-space-test");
      expect(fetchedBundle).toBeTruthy();
      expect(fetchedBundle?.targetAppVersion).toBe(">= 3.0.0");
    });

    it("should handle getBundles filtering with space-containing targetAppVersion", async () => {
      const bundle1 = createBundleJson(
        "production",
        "ios",
        ">= 3.0.0",
        "filter-test-1",
      );
      const bundle2 = createBundleJson(
        "production",
        "ios",
        "1.0.0",
        "filter-test-2",
      );

      await plugin.appendBundle(bundle1);
      await plugin.appendBundle(bundle2);
      await plugin.commitBundle();

      const result = await plugin.getBundles({
        where: { platform: "ios", channel: "production" },
        limit: 10,
        offset: 0,
      });

      expect(result.data).toHaveLength(2);
      const ids = result.data.map((b) => b.id);
      expect(ids).toContain("filter-test-1");
      expect(ids).toContain("filter-test-2");
    });

    it("should update target-app-versions.json correctly with normalized paths", async () => {
      const bundle = createBundleJson(
        "production",
        "ios",
        ">= 10.7.0",
        "target-versions-test",
      );

      await plugin.appendBundle(bundle);
      await plugin.commitBundle();

      // Check target-app-versions.json
      const targetVersionsKey = "production/ios/target-app-versions.json";
      const versions = JSON.parse(fakeStore[targetVersionsKey]);

      // Should contain the normalized version
      expect(versions).toContain(">=10.7.0");
    });

    it("should handle channel migration with space-containing targetAppVersion", async () => {
      const bundle = createBundleJson(
        "beta",
        "ios",
        ">= 5.0.0",
        "channel-migration-space-test",
      );

      await plugin.appendBundle(bundle);
      await plugin.commitBundle();

      cloudfrontInvalidations.length = 0;

      // Migrate to production channel
      await plugin.updateBundle("channel-migration-space-test", {
        channel: "production",
      });
      await plugin.commitBundle();

      // Assert: Bundle should be in new channel with normalized path
      const newKey = "production/ios/>=5.0.0/update.json";
      expect(fakeStore[newKey]).toBeDefined();

      const newBundles = JSON.parse(fakeStore[newKey]);
      expect(newBundles[0].id).toBe("channel-migration-space-test");
      expect(newBundles[0].channel).toBe("production");

      // Old channel should not have the bundle
      const oldKey = "beta/ios/>=5.0.0/update.json";
      const oldBundles = JSON.parse(fakeStore[oldKey] || "[]");
      expect(oldBundles).toHaveLength(0);

      // Should invalidate both old and new paths (URI encoded: >= becomes %3E=)
      const invalidatedPaths = cloudfrontInvalidations.flatMap(
        (inv) => inv.paths,
      );
      expect(invalidatedPaths).toContain("/beta/ios/%3E=5.0.0/update.json");
      expect(invalidatedPaths).toContain(
        "/production/ios/%3E=5.0.0/update.json",
      );
    });

    it("should handle mixed bundles (with and without spaces) in same channel", async () => {
      const bundle1 = createBundleJson(
        "production",
        "ios",
        "1.0.0",
        "mixed-exact",
      );
      const bundle2 = createBundleJson(
        "production",
        "ios",
        ">= 2.0.0",
        "mixed-range",
      );

      await plugin.appendBundle(bundle1);
      await plugin.appendBundle(bundle2);
      await plugin.commitBundle();

      // Both should be stored in their respective keys
      expect(fakeStore["production/ios/1.0.0/update.json"]).toBeDefined();
      expect(fakeStore["production/ios/>=2.0.0/update.json"]).toBeDefined();

      // getBundles should return both
      const result = await plugin.getBundles({
        where: { platform: "ios", channel: "production" },
        limit: 10,
        offset: 0,
      });

      expect(result.data).toHaveLength(2);
      const ids = result.data.map((b) => b.id);
      expect(ids).toContain("mixed-exact");
      expect(ids).toContain("mixed-range");
    });

    it("should encode normalized paths for CloudFront invalidation", async () => {
      // Test that special characters in normalized versions are properly encoded
      const bundle = createBundleJson(
        "production",
        "ios",
        ">= 1.0.0 < 2.0.0",
        "encoding-test",
      );

      cloudfrontInvalidations.length = 0;

      await plugin.appendBundle(bundle);
      await plugin.commitBundle();

      const invalidatedPaths = cloudfrontInvalidations.flatMap(
        (inv) => inv.paths,
      );

      // Paths should be URI encoded
      // After normalization: ">=1.0.0 <2.0.0" (space between comparators preserved)
      // After encoding: "%3E=1.0.0%20%3C2.0.0" (space becomes %20)
      const encodedUpdateJsonPath = invalidatedPaths.find((path) =>
        path.includes("update.json"),
      );
      expect(encodedUpdateJsonPath).toBeTruthy();
      // encodeURI encodes < and > but not =
      expect(encodedUpdateJsonPath).toContain("%3E");
      expect(encodedUpdateJsonPath).toContain("%3C");
    });
  });
});
