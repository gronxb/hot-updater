// s3Database.spec.ts
import { Buffer } from "buffer";
import { Readable } from "stream";
import {
  GetObjectCommand,
  ListObjectsV2Command,
  NoSuchKey,
  S3Client,
} from "@aws-sdk/client-s3";
import type { Bundle } from "@hot-updater/plugin-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { s3Database } from "./s3Database";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const DEFAULT_BUNDLE = {
  fileUrl: "http://example.com/bundle.zip",
  fileHash: "hash",
  gitCommitHash: null,
  message: null,
  enabled: true,
  shouldForceUpdate: false,
} as const;

const createBundleJson = (
  platform: "ios" | "android",
  targetAppVersion: string,
  id: string,
): Bundle => ({
  ...DEFAULT_BUNDLE,
  id,
  platform,
  targetAppVersion,
});

// fakeStore simulates files stored in S3
let fakeStore: Record<string, string> = {};

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

beforeEach(() => {
  fakeStore = {};
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
  // Create plugin: Pass BasePluginArgs like { cwd: "" }
  const plugin = s3Database({ bucketName, ...s3Config })({ cwd: "" });

  it("should append a new bundle and commit to S3", async () => {
    // Create new bundle
    const bundleKey = "ios/1.0.0/update.json";
    const targetVersionsKey = "ios/target-app-versions.json";
    const newBundle = createBundleJson(
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
    const bundleKey = "android/2.0.0/update.json";
    const targetVersionsKey = "android/target-app-versions.json";
    const initialBundle = createBundleJson(
      "android",
      "2.0.0",
      "00000000-0000-0000-0000-000000000002",
    );

    // Pre-populate bundle data in fakeStore
    fakeStore[bundleKey] = JSON.stringify([initialBundle]);
    fakeStore[targetVersionsKey] = JSON.stringify(["2.0.0"]);

    // Update bundle and commit
    await plugin.getBundles(true);
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

  it("should return cached bundles when refresh is false", async () => {
    const bundleKey = "ios/3.0.0/update.json";
    const bundle = createBundleJson(
      "ios",
      "3.0.0",
      "00000000-0000-0000-0000-000000000003",
    );

    // Pre-populate bundle data in fakeStore
    fakeStore[bundleKey] = JSON.stringify([bundle]);

    // Read bundles from S3 with refresh=true
    const bundlesFirst = await plugin.getBundles(true);
    expect(bundlesFirst).toStrictEqual([bundle]);

    // Verify cached data is returned even after deleting from fakeStore
    delete fakeStore[bundleKey];
    const bundlesSecond = await plugin.getBundles(false);
    expect(bundlesSecond).toStrictEqual([bundle]);
  });

  it("should throw an error when trying to update a non-existent bundle", async () => {
    await expect(
      plugin.updateBundle("nonexistent", { enabled: true }),
    ).rejects.toThrow("target bundle version not found");
  });

  it("should move a bundle from ios/1.x.x/update.json to ios/1.0.2/update.json when targetAppVersion is updated", async () => {
    const keyOld = "ios/1.x.x/update.json";
    const keyNew = "ios/1.0.2/update.json";
    const targetVersionsKey = "ios/target-app-versions.json";

    // Pre-populate bundle data in fakeStore
    const oldVersionBundles = [
      createBundleJson("ios", "1.x.x", "00000000-0000-0000-0000-000000000003"),
      createBundleJson("ios", "1.x.x", "00000000-0000-0000-0000-000000000002"),
      createBundleJson("ios", "1.x.x", "00000000-0000-0000-0000-000000000001"),
    ];

    const newVersionBundles = [
      createBundleJson("ios", "1.0.2", "00000000-0000-0000-0000-000000000005"),
      createBundleJson("ios", "1.0.2", "00000000-0000-0000-0000-000000000004"),
    ];

    // Configure update.json files (_updateJsonKey is added internally during getBundles())
    fakeStore[keyOld] = JSON.stringify(oldVersionBundles);
    fakeStore[keyNew] = JSON.stringify(newVersionBundles);

    // Set initial state of target-app-versions.json
    fakeStore[targetVersionsKey] = JSON.stringify(["1.x.x", "1.0.2"]);

    // Load all bundle info from S3 into memory cache
    await plugin.getBundles(true);

    // Update targetAppVersion of one bundle from ios/1.x.x to 1.0.2
    await plugin.updateBundle("00000000-0000-0000-0000-000000000003", {
      targetAppVersion: "1.0.2",
    });
    // Commit changes to S3
    await plugin.commitBundle();

    // ios/1.0.2/update.json should have 3 bundles: 2 existing + 1 moved
    const newFileBundles = JSON.parse(fakeStore[keyNew]);
    expect(newFileBundles).toStrictEqual([
      createBundleJson("ios", "1.0.2", "00000000-0000-0000-0000-000000000005"),
      createBundleJson("ios", "1.0.2", "00000000-0000-0000-0000-000000000004"),
      createBundleJson("ios", "1.0.2", "00000000-0000-0000-0000-000000000003"),
    ]);

    // And ios/1.x.x/update.json should have 2 remaining bundles
    const oldFileBundles = JSON.parse(fakeStore[keyOld]);
    expect(oldFileBundles).toStrictEqual([
      createBundleJson("ios", "1.x.x", "00000000-0000-0000-0000-000000000002"),
      createBundleJson("ios", "1.x.x", "00000000-0000-0000-0000-000000000001"),
    ]);

    // target-app-versions.json should have the new version
    const updatedVersions = JSON.parse(fakeStore[targetVersionsKey]);
    expect(updatedVersions).toStrictEqual(["1.x.x", "1.0.2"]);
  });

  it("should move all bundles from ios/1.0.2/update.json to ios/1.x.x/update.json when targetAppVersion is updated", async () => {
    const keyOld = "ios/1.x.x/update.json";
    const keyNew = "ios/1.0.2/update.json";
    const targetVersionsKey = "ios/target-app-versions.json";

    // Pre-populate bundle data in fakeStore
    const oldVersionBundles = [
      createBundleJson("ios", "1.x.x", "00000000-0000-0000-0000-000000000003"),
      createBundleJson("ios", "1.x.x", "00000000-0000-0000-0000-000000000002"),
      createBundleJson("ios", "1.x.x", "00000000-0000-0000-0000-000000000001"),
    ];

    const newVersionBundles = [
      createBundleJson("ios", "1.0.2", "00000000-0000-0000-0000-000000000005"),
      createBundleJson("ios", "1.0.2", "00000000-0000-0000-0000-000000000004"),
    ];

    // Configure update.json files (_updateJsonKey is added internally during getBundles())
    fakeStore[keyOld] = JSON.stringify(oldVersionBundles);
    fakeStore[keyNew] = JSON.stringify(newVersionBundles);

    // Set initial state of target-app-versions.json
    fakeStore[targetVersionsKey] = JSON.stringify(["1.x.x", "1.0.2"]);

    await plugin.getBundles(true);

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
      createBundleJson("ios", "1.x.x", "00000000-0000-0000-0000-000000000005"),
      createBundleJson("ios", "1.x.x", "00000000-0000-0000-0000-000000000004"),
      createBundleJson("ios", "1.x.x", "00000000-0000-0000-0000-000000000003"),
      createBundleJson("ios", "1.x.x", "00000000-0000-0000-0000-000000000002"),
      createBundleJson("ios", "1.x.x", "00000000-0000-0000-0000-000000000001"),
    ]);

    // target-app-versions.json should be updated
    const updatedVersions = JSON.parse(fakeStore[targetVersionsKey]);
    expect(updatedVersions).toStrictEqual(["1.x.x"]);
  });

  it("should gather bundles from multiple update.json paths across different platforms", async () => {
    // Arrange: Configure different bundle data in multiple update.json files
    const iosBundle1 = createBundleJson("ios", "1.0.0", "bundle-ios-1");
    const iosBundle2 = createBundleJson("ios", "2.0.0", "bundle-ios-2");
    const androidBundle1 = createBundleJson(
      "android",
      "1.0.0",
      "bundle-android-1",
    );

    // Valid update.json files
    fakeStore["ios/1.0.0/update.json"] = JSON.stringify([iosBundle1]);
    fakeStore["ios/2.0.0/update.json"] = JSON.stringify([iosBundle2]);
    fakeStore["android/1.0.0/update.json"] = JSON.stringify([androidBundle1]);

    // Invalid files: don't match pattern (should be ignored)
    fakeStore["ios/other.json"] = JSON.stringify([]);
    fakeStore["android/1.0.0/extra/update.json"] = JSON.stringify([
      createBundleJson("android", "1.0.0", "should-not-be-included"),
    ]);

    // Act: Force reload bundle info from S3
    const bundles = await plugin.getBundles(true);

    // Assert: Returned bundle list should only include valid bundles
    expect(bundles).toHaveLength(3);
    expect(bundles).toEqual(
      expect.arrayContaining([iosBundle1, iosBundle2, androidBundle1]),
    );
  });

  it("should return null for non-existent bundle id", async () => {
    // Verify null is returned for non-existent bundle ID
    const bundle = await plugin.getBundleById("non-existent-id");
    expect(bundle).toBeNull();
  });

  it("should not modify update.json when no bundles are marked as changed", async () => {
    // Verify existing update.json file is preserved
    const updateKey = "ios/1.0.0/update.json";
    const iosBundle = createBundleJson("ios", "1.0.0", "bundle-1");
    fakeStore[updateKey] = JSON.stringify([iosBundle]);
    // Pre-configure target-app-versions file
    const targetKey = "ios/target-app-versions.json";
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
      { bucketName, ...s3Config },
      { onDatabaseUpdated },
    )({ cwd: "" });
    const bundle = createBundleJson("ios", "1.0.0", "hook-test");
    await pluginWithHook.appendBundle(bundle);
    await pluginWithHook.commitBundle();
    expect(onDatabaseUpdated).toHaveBeenCalled();
  });

  it("should sort bundles in descending order based on id", async () => {
    // Verify bundles from multiple update.json files are sorted in descending order
    const bundleA = createBundleJson("ios", "1.0.0", "A");
    const bundleB = createBundleJson("ios", "1.0.0", "B");
    const bundleC = createBundleJson("ios", "1.0.0", "C");
    // Intentionally store in mixed order in fakeStore
    fakeStore["ios/1.0.0/update.json"] = JSON.stringify([bundleB, bundleA]);
    fakeStore["ios/2.0.0/update.json"] = JSON.stringify([bundleC]);

    const bundles = await plugin.getBundles(true);

    // Descending order: "C" > "B" > "A"
    expect(bundles).toEqual([bundleC, bundleB, bundleA]);
  });

  it("should return a bundle without internal keys from getBundleById", async () => {
    // Verify internal management keys (_updateJsonKey, _oldUpdateJsonKey) are removed when fetching by getBundleById
    const bundle = createBundleJson("android", "2.0.0", "internal-test");
    fakeStore["android/2.0.0/update.json"] = JSON.stringify([bundle]);
    await plugin.getBundles(true);
    const fetchedBundle = await plugin.getBundleById("internal-test");
    expect(fetchedBundle).not.toHaveProperty("_updateJsonKey");
    expect(fetchedBundle).not.toHaveProperty("_oldUpdateJsonKey");
    expect(fetchedBundle).toEqual(bundle);
  });

  it("should update a bundle without changing its updateJsonKey if platform and targetAppVersion remain unchanged", async () => {
    // Verify updateJsonKey remains unchanged if platform and targetAppVersion stay the same
    const bundle = createBundleJson("android", "2.0.0", "same-key-test");
    await plugin.appendBundle(bundle);
    // Change only enabled property → path should remain the same
    await plugin.updateBundle("same-key-test", { enabled: false });
    await plugin.commitBundle();

    const updateKey = "android/2.0.0/update.json";
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
    const bundles = await plugin.getBundles(true);
    expect(bundles).toEqual([]);
  });

  it("should append multiple bundles and commit them to the correct update.json files", async () => {
    // Verify multiple bundles are added to their respective platform/version paths
    const bundle1 = createBundleJson("ios", "1.0.0", "multi-1");
    const bundle2 = createBundleJson("android", "2.0.0", "multi-2");

    await plugin.appendBundle(bundle1);
    await plugin.appendBundle(bundle2);
    await plugin.commitBundle();

    const iosUpdateKey = "ios/1.0.0/update.json";
    const androidUpdateKey = "android/2.0.0/update.json";

    const iosBundles = JSON.parse(fakeStore[iosUpdateKey]);
    const androidBundles = JSON.parse(fakeStore[androidUpdateKey]);

    expect(iosBundles).toEqual([bundle1]);
    expect(androidBundles).toEqual([bundle2]);
  });

  it("should not update S3 until commitBundle is called", async () => {
    const bundleKey = "ios/1.0.0/update.json";
    const newBundle = createBundleJson(
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
});
