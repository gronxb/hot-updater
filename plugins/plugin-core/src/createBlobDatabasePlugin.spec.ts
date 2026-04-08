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

const MANAGEMENT_INDEX_PREFIX = "_index";
const MANAGEMENT_INDEX_VERSION = 1;
const MANAGEMENT_INDEX_PAGE_SIZE = 64;

type ManagementScope = {
  channel?: string;
  platform?: "ios" | "android";
};

// fakeStore simulates files stored in S3
let fakeStore: Record<string, string> = {};
// 캐시 무효화 요청을 추적하기 위한 배열
let cloudfrontInvalidations: { paths: string[] }[] = [];
let listObjectCalls: string[] = [];
let loadObjectCalls: string[] = [];

beforeEach(() => {
  fakeStore = {};
  cloudfrontInvalidations = [];
  listObjectCalls = [];
  loadObjectCalls = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("blobDatabase plugin", () => {
  async function listObjects(prefix: string): Promise<string[]> {
    listObjectCalls.push(prefix);
    const keys = Object.keys(fakeStore).filter((key) => key.startsWith(prefix));
    return keys;
  }

  async function loadObject<T>(path: string): Promise<T | null> {
    loadObjectCalls.push(path);
    const data = fakeStore[path];
    if (data) {
      return JSON.parse(data);
    }
    return null;
  }

  async function uploadObject<T>(path: string, data: T): Promise<void> {
    fakeStore[path] = JSON.stringify(data);
  }

  async function deleteObject(path: string): Promise<void> {
    delete fakeStore[path];
  }

  async function invalidatePaths(paths: string[]) {
    cloudfrontInvalidations.push({ paths });
  }

  let plugin = createBlobDatabasePlugin({
    name: "blobDatabase",
    factory: () => ({
      apiBasePath: "/api/check-update",
      listObjects,
      loadObject,
      uploadObject,
      deleteObject,
      invalidatePaths,
    }),
  })({})();

  beforeEach(async () => {
    plugin = createBlobDatabasePlugin({
      name: "blobDatabase",
      factory: () => ({
        apiBasePath: "/api/check-update",
        listObjects,
        loadObject,
        uploadObject,
        deleteObject,
        invalidatePaths,
      }),
    })({})();
  });

  const seedUpdateManifests = (bundles: Bundle[]) => {
    const bundlesByKey = new Map<string, Bundle[]>();
    const targetVersionsByKey = new Map<string, Set<string>>();

    for (const bundle of bundles) {
      const target = bundle.targetAppVersion ?? bundle.fingerprintHash;
      if (!target) {
        continue;
      }

      const key = `${bundle.channel}/${bundle.platform}/${target}/update.json`;
      const storedBundles = bundlesByKey.get(key) ?? [];
      storedBundles.push(bundle);
      bundlesByKey.set(key, storedBundles);

      if (bundle.targetAppVersion) {
        const targetVersionsKey = `${bundle.channel}/${bundle.platform}/target-app-versions.json`;
        const targetVersions =
          targetVersionsByKey.get(targetVersionsKey) ?? new Set<string>();
        targetVersions.add(bundle.targetAppVersion);
        targetVersionsByKey.set(targetVersionsKey, targetVersions);
      }
    }

    for (const [key, storedBundles] of bundlesByKey.entries()) {
      fakeStore[key] = JSON.stringify(
        storedBundles.sort((left, right) => right.id.localeCompare(left.id)),
      );
    }

    for (const [key, targetVersions] of targetVersionsByKey.entries()) {
      fakeStore[key] = JSON.stringify(Array.from(targetVersions));
    }
  };

  const getManagementScopePrefix = ({ channel, platform }: ManagementScope) => {
    if (channel && platform) {
      return `${MANAGEMENT_INDEX_PREFIX}/channel/${encodeURIComponent(channel)}/platform/${platform}`;
    }

    if (channel) {
      return `${MANAGEMENT_INDEX_PREFIX}/channel/${encodeURIComponent(channel)}`;
    }

    if (platform) {
      return `${MANAGEMENT_INDEX_PREFIX}/platform/${platform}`;
    }

    return `${MANAGEMENT_INDEX_PREFIX}/all`;
  };

  const getManagementRootKey = (scope: ManagementScope) =>
    `${getManagementScopePrefix(scope)}/root.json`;

  const getManagementPageKey = (scope: ManagementScope, pageIndex: number) =>
    `${getManagementScopePrefix(scope)}/pages/${String(pageIndex).padStart(4, "0")}.json`;

  const sortManagementBundles = (bundles: Bundle[]) =>
    bundles.slice().sort((left, right) => right.id.localeCompare(left.id));

  const seedPagedBundlesIndex = (bundles: Bundle[]) => {
    const sortedBundles = sortManagementBundles(bundles);
    const channels = [
      ...new Set(sortedBundles.map((bundle) => bundle.channel)),
    ].sort();

    const addScope = (
      scope: ManagementScope,
      scopedBundles: Bundle[],
      options?: { includeChannels?: boolean },
    ) => {
      if (!options?.includeChannels && scopedBundles.length === 0) {
        return;
      }

      const pages = [];
      for (
        let pageIndex = 0;
        pageIndex * MANAGEMENT_INDEX_PAGE_SIZE < scopedBundles.length;
        pageIndex++
      ) {
        const page = scopedBundles.slice(
          pageIndex * MANAGEMENT_INDEX_PAGE_SIZE,
          (pageIndex + 1) * MANAGEMENT_INDEX_PAGE_SIZE,
        );
        const key = getManagementPageKey(scope, pageIndex);
        fakeStore[key] = JSON.stringify(page);
        pages.push({
          key,
          count: page.length,
          firstId: page[0]!.id,
          lastId: page.at(-1)!.id,
        });
      }

      fakeStore[getManagementRootKey(scope)] = JSON.stringify({
        version: MANAGEMENT_INDEX_VERSION,
        pageSize: MANAGEMENT_INDEX_PAGE_SIZE,
        total: scopedBundles.length,
        pages,
        ...(options?.includeChannels ? { channels } : {}),
      });
    };

    addScope({}, sortedBundles, { includeChannels: true });

    for (const channel of channels) {
      const channelBundles = sortedBundles.filter(
        (bundle) => bundle.channel === channel,
      );
      addScope({ channel }, channelBundles);

      for (const platform of ["ios", "android"] as const) {
        addScope(
          { channel, platform },
          channelBundles.filter((bundle) => bundle.platform === platform),
        );
      }
    }

    for (const platform of ["ios", "android"] as const) {
      addScope(
        { platform },
        sortedBundles.filter((bundle) => bundle.platform === platform),
      );
    }
  };

  const createScopedBundles = ({
    channel = "production",
    platform = "ios",
    count,
  }: {
    channel?: string;
    platform?: "ios" | "android";
    count: number;
  }) =>
    Array.from({ length: count }, (_, index) => {
      const id = `bundle-${String(count - index).padStart(3, "0")}`;
      return createBundleJson(channel, platform, "1.0.0", id);
    });

  it("uses direct app-version manifests for update checks without reloading all bundles", async () => {
    const latestBundle = createBundleJson(
      "production",
      "ios",
      "*",
      "00000000-0000-0000-0000-000000000002",
    );
    const previousBundle = createBundleJson(
      "production",
      "ios",
      "*",
      "00000000-0000-0000-0000-000000000001",
    );

    seedUpdateManifests([previousBundle, latestBundle]);

    await expect(
      plugin.getUpdateInfo?.({
        _updateStrategy: "appVersion",
        appVersion: "1.0.0",
        bundleId: "00000000-0000-0000-0000-000000000000",
        platform: "ios",
      }),
    ).resolves.toEqual({
      fileHash: latestBundle.fileHash,
      id: latestBundle.id,
      message: latestBundle.message,
      shouldForceUpdate: latestBundle.shouldForceUpdate,
      status: "UPDATE",
      storageUri: latestBundle.storageUri,
    });

    expect(listObjectCalls).toEqual([]);
    expect(loadObjectCalls).toEqual([
      "production/ios/target-app-versions.json",
      "production/ios/*/update.json",
    ]);
  });

  it("uses fingerprint manifests directly for update checks", async () => {
    const fingerprintBundle: Bundle = {
      ...DEFAULT_BUNDLE,
      channel: "production",
      id: "00000000-0000-0000-0000-000000000010",
      platform: "ios",
      targetAppVersion: null,
      fingerprintHash: "fingerprint-1",
    };

    seedUpdateManifests([fingerprintBundle]);

    await expect(
      plugin.getUpdateInfo?.({
        _updateStrategy: "fingerprint",
        bundleId: "00000000-0000-0000-0000-000000000000",
        fingerprintHash: "fingerprint-1",
        platform: "ios",
      }),
    ).resolves.toEqual({
      fileHash: fingerprintBundle.fileHash,
      id: fingerprintBundle.id,
      message: fingerprintBundle.message,
      shouldForceUpdate: fingerprintBundle.shouldForceUpdate,
      status: "UPDATE",
      storageUri: fingerprintBundle.storageUri,
    });

    expect(listObjectCalls).toEqual([]);
    expect(loadObjectCalls).toEqual([
      "production/ios/fingerprint-1/update.json",
    ]);
  });

  it("respects cohort eligibility when selecting app-version updates", async () => {
    const gatedBundle: Bundle = {
      ...createBundleJson(
        "production",
        "ios",
        "*",
        "00000000-0000-0000-0000-000000000021",
      ),
      targetCohorts: ["beta"],
    };
    const fallbackBundle = createBundleJson(
      "production",
      "ios",
      "*",
      "00000000-0000-0000-0000-000000000020",
    );
    fallbackBundle.targetCohorts = ["stable"];

    seedUpdateManifests([fallbackBundle, gatedBundle]);

    await expect(
      plugin.getUpdateInfo?.({
        _updateStrategy: "appVersion",
        appVersion: "1.0.0",
        bundleId: "00000000-0000-0000-0000-000000000000",
        cohort: "stable",
        platform: "ios",
      }),
    ).resolves.toMatchObject({
      id: fallbackBundle.id,
      status: "UPDATE",
    });
  });

  it("returns rollback candidates from direct manifests when the current bundle is no longer eligible", async () => {
    const currentBundle: Bundle = {
      ...createBundleJson(
        "production",
        "ios",
        "*",
        "00000000-0000-0000-0000-000000000031",
      ),
      targetCohorts: ["beta"],
    };
    const rollbackBundle = createBundleJson(
      "production",
      "ios",
      "*",
      "00000000-0000-0000-0000-000000000030",
    );

    seedUpdateManifests([rollbackBundle, currentBundle]);

    await expect(
      plugin.getUpdateInfo?.({
        _updateStrategy: "appVersion",
        appVersion: "1.0.0",
        bundleId: currentBundle.id,
        cohort: "stable",
        platform: "ios",
      }),
    ).resolves.toEqual({
      fileHash: rollbackBundle.fileHash,
      id: rollbackBundle.id,
      message: rollbackBundle.message,
      shouldForceUpdate: true,
      status: "ROLLBACK",
      storageUri: rollbackBundle.storageUri,
    });
  });

  it("respects minBundleId when no direct-manifest candidates are available", async () => {
    await expect(
      plugin.getUpdateInfo?.({
        _updateStrategy: "appVersion",
        appVersion: "1.0.0",
        bundleId: "00000000-0000-0000-0000-000000000040",
        minBundleId: "00000000-0000-0000-0000-000000000040",
        platform: "ios",
      }),
    ).resolves.toBeNull();
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
      factory: () => ({
        apiBasePath: "/api/check-update",
        listObjects,
        loadObject,
        uploadObject,
        deleteObject,
        invalidatePaths,
      }),
    })({}, { onDatabaseUpdated })();
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

  it("rebuilds paged management indexes with one broad scan, then serves later cursor reads without rescanning", async () => {
    const bundleA = createBundleJson("production", "ios", "1.0.0", "index-A");
    const bundleB = createBundleJson("production", "ios", "1.0.0", "index-B");
    fakeStore["production/ios/1.0.0/update.json"] = JSON.stringify([
      bundleA,
      bundleB,
    ]);

    await plugin.getBundles({ limit: 20, offset: 0 });

    expect(fakeStore[getManagementRootKey({})]).toBeDefined();
    expect(fakeStore[getManagementPageKey({}, 0)]).toBeDefined();
    expect(listObjectCalls).toEqual([""]);
    expect(loadObjectCalls.slice().sort()).toEqual(
      [
        getManagementRootKey({}),
        getManagementPageKey({}, 0),
        "production/ios/1.0.0/update.json",
      ].sort(),
    );

    listObjectCalls = [];
    loadObjectCalls = [];

    await plugin.getBundles({
      limit: 1,
      where: { channel: "production", platform: "ios" },
      cursor: {
        after: bundleB.id,
      },
    });

    expect(listObjectCalls).toEqual([]);
    expect(loadObjectCalls).toEqual([
      getManagementPageKey({ channel: "production", platform: "ios" }, 0),
    ]);
  });

  it("reads the first all-bundles page from one root and one leaf page", async () => {
    const bundles = createScopedBundles({ count: 70 });
    seedPagedBundlesIndex(bundles);
    listObjectCalls = [];
    loadObjectCalls = [];

    const result = await plugin.getBundles({ limit: 20, offset: 0 });

    expect(result.data.map((bundle) => bundle.id)).toEqual(
      bundles.slice(0, 20).map((bundle) => bundle.id),
    );
    expect(listObjectCalls).toEqual([]);
    expect(loadObjectCalls).toEqual([
      getManagementRootKey({}),
      getManagementPageKey({}, 0),
    ]);
  });

  it.each([
    {
      label: "channel scope",
      where: { channel: "production" } as const,
      expectedKeys: [
        getManagementRootKey({ channel: "production" }),
        getManagementPageKey({ channel: "production" }, 0),
      ],
    },
    {
      label: "platform scope",
      where: { platform: "ios" } as const,
      expectedKeys: [
        getManagementRootKey({ platform: "ios" }),
        getManagementPageKey({ platform: "ios" }, 0),
      ],
    },
    {
      label: "channel + platform scope",
      where: { channel: "production", platform: "ios" } as const,
      expectedKeys: [
        getManagementRootKey({ channel: "production", platform: "ios" }),
        getManagementPageKey({ channel: "production", platform: "ios" }, 0),
      ],
    },
  ])(
    "reads warm filtered bundles with minimal objects for $label",
    async ({ where, expectedKeys }) => {
      const bundles = [
        ...createScopedBundles({
          count: 70,
          channel: "production",
          platform: "ios",
        }),
        ...createScopedBundles({
          count: 10,
          channel: "production",
          platform: "android",
        }),
        ...createScopedBundles({
          count: 10,
          channel: "staging",
          platform: "ios",
        }),
      ];
      seedPagedBundlesIndex(bundles);
      listObjectCalls = [];
      loadObjectCalls = [];

      await plugin.getBundles({
        where,
        limit: 20,
        cursor: {
          after: "bundle-999",
        },
      });

      expect(listObjectCalls).toEqual([]);
      expect(loadObjectCalls).toEqual(expectedKeys);
    },
  );

  it("reads at most two leaf pages when an after cursor crosses a page boundary", async () => {
    const bundles = createScopedBundles({ count: 70 });
    seedPagedBundlesIndex(bundles);
    listObjectCalls = [];
    loadObjectCalls = [];

    const result = await plugin.getBundles({
      where: { channel: "production", platform: "ios" },
      limit: 20,
      cursor: {
        after: "bundle-021",
      },
    });

    expect(result.data.map((bundle) => bundle.id)).toEqual(
      Array.from(
        { length: 20 },
        (_, index) => `bundle-${String(20 - index).padStart(3, "0")}`,
      ),
    );
    expect(listObjectCalls).toEqual([]);
    expect(loadObjectCalls).toEqual([
      getManagementRootKey({ channel: "production", platform: "ios" }),
      getManagementPageKey({ channel: "production", platform: "ios" }, 0),
      getManagementPageKey({ channel: "production", platform: "ios" }, 1),
    ]);
  });

  it("reads at most two leaf pages when a before cursor crosses a page boundary", async () => {
    const bundles = createScopedBundles({ count: 70 });
    seedPagedBundlesIndex(bundles);
    listObjectCalls = [];
    loadObjectCalls = [];

    const result = await plugin.getBundles({
      where: { channel: "production", platform: "ios" },
      limit: 20,
      cursor: {
        before: "bundle-005",
      },
    });

    expect(result.data.map((bundle) => bundle.id)).toEqual(
      Array.from(
        { length: 20 },
        (_, index) => `bundle-${String(25 - index).padStart(3, "0")}`,
      ),
    );
    expect(listObjectCalls).toEqual([]);
    expect(loadObjectCalls).toEqual([
      getManagementRootKey({ channel: "production", platform: "ios" }),
      getManagementPageKey({ channel: "production", platform: "ios" }, 1),
      getManagementPageKey({ channel: "production", platform: "ios" }, 0),
    ]);
  });

  it("reads channels from the all-bundles root only", async () => {
    seedPagedBundlesIndex([
      ...createScopedBundles({
        count: 2,
        channel: "production",
        platform: "ios",
      }),
      ...createScopedBundles({
        count: 2,
        channel: "staging",
        platform: "android",
      }),
    ]);
    listObjectCalls = [];
    loadObjectCalls = [];

    await expect(plugin.getChannels()).resolves.toEqual([
      "production",
      "staging",
    ]);

    expect(listObjectCalls).toEqual([]);
    expect(loadObjectCalls).toEqual([getManagementRootKey({})]);
  });

  it("reads bundle detail from the all-bundles root and one leaf page", async () => {
    const bundles = createScopedBundles({ count: 70 });
    seedPagedBundlesIndex(bundles);
    listObjectCalls = [];
    loadObjectCalls = [];

    await expect(plugin.getBundleById("bundle-005")).resolves.toMatchObject({
      id: "bundle-005",
    });

    expect(listObjectCalls).toEqual([]);
    expect(loadObjectCalls).toEqual([
      getManagementRootKey({}),
      getManagementPageKey({}, 1),
    ]);
  });

  it("refreshes a stale cached management root before falling back to a broad scan for bundle detail", async () => {
    await plugin.getChannels();

    const bundle = createBundleJson(
      "production",
      "ios",
      "1.0.0",
      "bundle-stale-root",
    );
    seedPagedBundlesIndex([bundle]);
    listObjectCalls = [];
    loadObjectCalls = [];

    await expect(plugin.getBundleById(bundle.id)).resolves.toMatchObject({
      id: bundle.id,
    });

    expect(listObjectCalls).toEqual([]);
    expect(loadObjectCalls).toEqual([
      getManagementRootKey({}),
      getManagementPageKey({}, 0),
    ]);
  });

  it("supports cursor pagination from the index manifest", async () => {
    const bundles = [
      createBundleJson("production", "ios", "1.0.0", "bundle-300"),
      createBundleJson("production", "ios", "1.0.0", "bundle-200"),
      createBundleJson("production", "ios", "1.0.0", "bundle-100"),
    ];

    await plugin.appendBundle(bundles[0]);
    await plugin.appendBundle(bundles[1]);
    await plugin.appendBundle(bundles[2]);
    await plugin.commitBundle();

    const firstPage = await plugin.getBundles({
      where: { channel: "production", platform: "ios" },
      limit: 2,
      offset: 0,
    });

    expect(firstPage.data.map((bundle) => bundle.id)).toEqual([
      "bundle-300",
      "bundle-200",
    ]);
    expect(firstPage.pagination).toEqual({
      total: 3,
      hasNextPage: true,
      hasPreviousPage: false,
      currentPage: 1,
      totalPages: 2,
      nextCursor: "bundle-200",
    });
    expect(firstPage.pagination.nextCursor).toBe("bundle-200");

    const secondPage = await plugin.getBundles({
      where: { channel: "production", platform: "ios" },
      limit: 2,
      offset: 2,
      cursor: {
        after: firstPage.pagination.nextCursor ?? undefined,
      },
    });

    expect(secondPage.data.map((bundle) => bundle.id)).toEqual(["bundle-100"]);
    expect(secondPage.pagination).toEqual({
      total: 3,
      hasNextPage: false,
      hasPreviousPage: true,
      currentPage: 2,
      totalPages: 2,
      previousCursor: "bundle-100",
    });
    expect(secondPage.pagination.previousCursor).toBe("bundle-100");

    const previousPage = await plugin.getBundles({
      where: { channel: "production", platform: "ios" },
      limit: 2,
      offset: 0,
      cursor: {
        before: secondPage.pagination.previousCursor ?? undefined,
      },
    });

    expect(previousPage.data.map((bundle) => bundle.id)).toEqual([
      "bundle-300",
      "bundle-200",
    ]);
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
    expect(invalidatedPaths.some((path) => path.includes("update.json"))).toBe(
      false,
    );
    expect(
      invalidatedPaths.some((path) =>
        path.includes("target-app-versions.json"),
      ),
    ).toBe(false);
    expect(invalidatedPaths).toContain(
      "/api/check-update/app-version/ios/1.0.0/production/*",
    );
  });

  it("should trigger CloudFront invalidation when a bundle is updated without key change", async () => {
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
    expect(invalidatedPaths.some((path) => path.includes("update.json"))).toBe(
      false,
    );
    expect(
      invalidatedPaths.some((path) =>
        path.includes("target-app-versions.json"),
      ),
    ).toBe(false);
    expect(invalidatedPaths).toContain(
      "/api/check-update/app-version/ios/1.0.0/production/*",
    );
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

    expect(invalidationPaths.some((path) => path.includes("update.json"))).toBe(
      false,
    );

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

    expect(allPaths.some((path) => path.includes("update.json"))).toBe(false);

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

    expect(allPaths.some((path) => path.includes("update.json"))).toBe(false);
    expect(
      allPaths.some((path) => path.includes("target-app-versions.json")),
    ).toBe(false);
    expect(allPaths).toContain(
      "/api/check-update/app-version/ios/1.0.0/beta/*",
    );
    expect(allPaths).toContain(
      "/api/check-update/app-version/ios/1.0.0/production/*",
    );
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

      expect(invalidatedPaths).toContain("/api/check-update/app-version/ios/*");
      expect(
        invalidatedPaths.some((path) => path.includes("update.json")),
      ).toBe(false);
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

      const invalidatedPaths = cloudfrontInvalidations.flatMap(
        (inv) => inv.paths,
      );
      expect(invalidatedPaths).toContain(
        "/api/check-update/app-version/android/*",
      );
      expect(
        invalidatedPaths.some((path) => path.includes("update.json")),
      ).toBe(false);
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

      const invalidatedPaths = cloudfrontInvalidations.flatMap(
        (inv) => inv.paths,
      );
      expect(invalidatedPaths).toContain("/api/check-update/app-version/ios/*");
      expect(
        invalidatedPaths.some((path) => path.includes("update.json")),
      ).toBe(false);
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

    it("should only invalidate API paths for CloudFront invalidation", async () => {
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

      expect(
        invalidatedPaths.some((path) => path.includes("update.json")),
      ).toBe(false);
      expect(
        invalidatedPaths.some((path) =>
          path.includes("target-app-versions.json"),
        ),
      ).toBe(false);
      expect(invalidatedPaths).toContain("/api/check-update/app-version/ios/*");
    });
  });

  describe("issue #745 promotion scenario", () => {
    it("should update target-app-versions.json while invalidating expected paths when promoting from test to prod", async () => {
      // Regression scenario from:
      // https://github.com/gronxb/hot-updater/issues/745
      // 1) deploy disabled bundle to test
      // 2) promote bundle from test to prod (no copy)
      const bundle = createBundleJson(
        "test",
        "android",
        "8.1.3",
        "issue-745-promote-bundle",
      );
      bundle.enabled = false;

      await plugin.appendBundle(bundle);
      await plugin.commitBundle();

      // Clear initial deployment invalidations; we only want promotion invalidation.
      cloudfrontInvalidations.length = 0;

      await plugin.updateBundle("issue-745-promote-bundle", {
        channel: "prod",
      });
      await plugin.commitBundle();

      const invalidatedPaths = cloudfrontInvalidations.flatMap(
        (inv) => inv.paths,
      );

      expect(invalidatedPaths).toEqual(
        expect.arrayContaining([
          "/api/check-update/app-version/android/8.1.3/test/*",
          "/api/check-update/app-version/android/8.1.3/prod/*",
        ]),
      );
      expect(
        invalidatedPaths.some((path) => path.includes("update.json")),
      ).toBe(false);
      expect(
        invalidatedPaths.some((path) =>
          path.includes("target-app-versions.json"),
        ),
      ).toBe(false);

      // Expected S3 state after promotion:
      // - prod target-app-versions should include 8.1.3
      // - test target-app-versions should no longer include 8.1.3
      const prodTargetVersions = JSON.parse(
        fakeStore["prod/android/target-app-versions.json"] || "[]",
      );
      const testTargetVersions = JSON.parse(
        fakeStore["test/android/target-app-versions.json"] || "[]",
      );

      expect(prodTargetVersions).toContain("8.1.3");
      expect(testTargetVersions).not.toContain("8.1.3");
    });
  });
});
