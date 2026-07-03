import { Buffer } from "buffer";
import { Readable } from "stream";

import {
  CreateInvalidationCommand,
  GetInvalidationCommand,
} from "@aws-sdk/client-cloudfront";
import {
  GetObjectCommand,
  ListObjectsV2Command,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { deleteBundleById, type Bundle } from "@hot-updater/plugin-core";
import { setupBundleMethodsTestSuite } from "@hot-updater/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type S3DatabaseConfig, s3Database } from "./s3Database";

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

const MANAGEMENT_INDEX_PREFIX = "_index";

// fakeStore simulates files stored in S3
let fakeStore: Record<string, string> = {};
let cloudfrontInvalidations: { paths: string[]; distributionId: string }[] = [];
let cloudfrontInvalidationError: Error | null = null;
let cloudfrontGetInvalidationCalls: string[] = [];
let cloudfrontGetInvalidationError: Error | null = null;
let cloudfrontInvalidationCounter = 0;
let nextCloudfrontInvalidationStatuses: string[] | null = null;
let cloudfrontInvalidationStatuses = new Map<string, string[]>();
let listedObjectPrefixes: string[] = [];
let listedObjectRequests: {
  readonly delimiter?: string;
  readonly prefix: string;
}[] = [];
let activeListObjectRequests = 0;
let maxActiveListObjectRequests = 0;
let loadedObjectKeys: string[] = [];
let archivedObjectKeys = new Map<string, string>();
let putObjectKeys: string[] = [];

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
          if (cloudfrontInvalidationError) {
            const error = cloudfrontInvalidationError;
            cloudfrontInvalidationError = null;
            return Promise.reject(error);
          }
          const invalidationId = `invalidation-${++cloudfrontInvalidationCounter}`;
          const statuses = nextCloudfrontInvalidationStatuses
            ? [...nextCloudfrontInvalidationStatuses]
            : ["InProgress"];
          nextCloudfrontInvalidationStatuses = null;
          cloudfrontInvalidationStatuses.set(invalidationId, statuses);
          cloudfrontInvalidations.push({
            paths: command.input.InvalidationBatch?.Paths?.Items ?? [],
            distributionId: command.input.DistributionId ?? "",
          });
          return Promise.resolve({
            Invalidation: {
              Id: invalidationId,
              Status: statuses[0] ?? "InProgress",
            },
          });
        }

        if (command instanceof GetInvalidationCommand) {
          if (cloudfrontGetInvalidationError) {
            const error = cloudfrontGetInvalidationError;
            cloudfrontGetInvalidationError = null;
            return Promise.reject(error);
          }

          const invalidationId = command.input.Id ?? "";
          const statuses = cloudfrontInvalidationStatuses.get(
            invalidationId,
          ) ?? ["Completed"];
          const status = statuses[0] ?? "Completed";

          if (statuses.length > 1) {
            statuses.shift();
            cloudfrontInvalidationStatuses.set(invalidationId, statuses);
          }

          cloudfrontGetInvalidationCalls.push(invalidationId);

          return Promise.resolve({
            Invalidation: {
              Id: invalidationId,
              Status: status,
            },
          });
        }

        return Promise.resolve({});
      }
    },
    CreateInvalidationCommand: actual.CreateInvalidationCommand,
    GetInvalidationCommand: actual.GetInvalidationCommand,
  };
});

beforeEach(() => {
  fakeStore = {};
  cloudfrontInvalidations = [];
  cloudfrontInvalidationError = null;
  cloudfrontGetInvalidationCalls = [];
  cloudfrontGetInvalidationError = null;
  cloudfrontInvalidationCounter = 0;
  nextCloudfrontInvalidationStatuses = null;
  cloudfrontInvalidationStatuses = new Map();
  listedObjectPrefixes = [];
  listedObjectRequests = [];
  activeListObjectRequests = 0;
  maxActiveListObjectRequests = 0;
  loadedObjectKeys = [];
  archivedObjectKeys = new Map();
  putObjectKeys = [];
  vi.spyOn(S3Client.prototype, "send").mockImplementation(
    async (command: any) => {
      await delay(5);
      if (command instanceof ListObjectsV2Command) {
        activeListObjectRequests += 1;
        maxActiveListObjectRequests = Math.max(
          maxActiveListObjectRequests,
          activeListObjectRequests,
        );
        await delay(5);
        const prefix = command.input.Prefix ?? "";
        const delimiter = command.input.Delimiter;
        listedObjectPrefixes.push(prefix);
        listedObjectRequests.push(
          typeof delimiter === "string" ? { delimiter, prefix } : { prefix },
        );
        const keys = Object.keys(fakeStore).filter((key) =>
          key.startsWith(prefix),
        );

        if (typeof delimiter === "string") {
          const directKeys: string[] = [];
          const commonPrefixes = new Set<string>();

          try {
            for (const key of keys) {
              const rest = key.slice(prefix.length);
              const delimiterIndex = rest.indexOf(delimiter);

              if (delimiterIndex === -1) {
                directKeys.push(key);
                continue;
              }

              commonPrefixes.add(
                `${prefix}${rest.slice(0, delimiterIndex + delimiter.length)}`,
              );
            }

            return {
              CommonPrefixes: Array.from(commonPrefixes).map((Prefix) => ({
                Prefix,
              })),
              Contents: directKeys.map((Key) => ({ Key })),
              NextContinuationToken: undefined,
            };
          } finally {
            activeListObjectRequests -= 1;
          }
        }

        try {
          return {
            Contents: keys.map((key) => ({ Key: key })),
            NextContinuationToken: undefined,
          };
        } finally {
          activeListObjectRequests -= 1;
        }
      }
      if (command instanceof GetObjectCommand) {
        const key = command.input.Key;
        if (key) {
          loadedObjectKeys.push(key);
        }
        if (key && archivedObjectKeys.has(key)) {
          const error = new Error(
            "The operation is not valid for the object's storage class",
          );
          error.name = "InvalidObjectState";
          Object.assign(error, {
            Code: "InvalidObjectState",
            StorageClass: archivedObjectKeys.get(key),
          });
          throw error;
        }
        if (key && fakeStore[key] !== undefined) {
          await delay(7);
          return { Body: Readable.from([Buffer.from(fakeStore[key])]) };
        }
        const error = new Error("NoSuchKey");
        Object.setPrototypeOf(error, NoSuchKey.prototype);
        throw error;
      }
      if (command instanceof PutObjectCommand) {
        const key = command.input.Key;
        if (key) {
          putObjectKeys.push(key);
          await delay(10);
          fakeStore[key] = String(command.input.Body ?? "");
        }
        return {};
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
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("s3Database plugin", () => {
  const bucketName = "test-bucket";
  const s3Config = {};
  const createPlugin = (config: Partial<S3DatabaseConfig> = {}) =>
    s3Database({
      bucketName,
      ...s3Config,
      cloudfrontDistributionId: "test-distribution-id",
      ...config,
    })();

  let plugin = createPlugin();

  beforeEach(async () => {
    plugin = createPlugin();
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

  const seedStaleManagementIndex = (bundles: Bundle[]) => {
    fakeStore[`${MANAGEMENT_INDEX_PREFIX}/all/pages/0000.json`] =
      JSON.stringify(bundles);
    fakeStore[`${MANAGEMENT_INDEX_PREFIX}/all/root.json`] = JSON.stringify({
      total: bundles.length,
      pages: [
        {
          key: `${MANAGEMENT_INDEX_PREFIX}/all/pages/0000.json`,
          count: bundles.length,
        },
      ],
    });
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

  setupBundleMethodsTestSuite({
    getBundleById: (id) => plugin.bundles.get(undefined, { id: id }),
    getChannels: () => plugin.channels.getChannels(),
    insertBundle: async (bundle) => {
      await plugin.bundles.append(undefined, { data: bundle });
      await plugin.commit(undefined, {});
    },
    getBundles: (options) => plugin.bundles.list(undefined, options),
    updateBundleById: async (bundleId, newBundle) => {
      await plugin.bundles.update(undefined, { id: bundleId, data: newBundle });
      await plugin.commit(undefined, {});
    },
    deleteBundleById: async (bundleId) => {
      const bundle = await plugin.bundles.get(undefined, { id: bundleId });
      if (!bundle) {
        return;
      }
      await deleteBundleById(plugin, undefined, {
        id: bundle.id,
        bundle: bundle,
      });
      await plugin.commit(undefined, {});
    },
  });

  beforeEach(() => {
    fakeStore = {};
    listedObjectPrefixes = [];
    listedObjectRequests = [];
    activeListObjectRequests = 0;
    maxActiveListObjectRequests = 0;
    loadedObjectKeys = [];
    putObjectKeys = [];
    plugin = createPlugin();
  });

  it("uses direct app-version manifests for update checks without listing S3 objects", async () => {
    const previousBundle = createBundleJson(
      "production",
      "ios",
      "*",
      "00000000-0000-0000-0000-000000000001",
    );
    const latestBundle = createBundleJson(
      "production",
      "ios",
      "*",
      "00000000-0000-0000-0000-000000000002",
    );

    seedUpdateManifests([previousBundle, latestBundle]);
    listedObjectPrefixes = [];
    loadedObjectKeys = [];

    await expect(
      plugin.updates?.check(undefined, {
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

    expect(listedObjectPrefixes).toEqual([]);
    expect(loadedObjectKeys).toEqual([
      "production/ios/target-app-versions.json",
      "production/ios/*/update.json",
    ]);
  });

  it("uses direct fingerprint manifests for update checks without listing S3 objects", async () => {
    const fingerprintBundle = createBundleJsonFingerprint(
      "production",
      "ios",
      "fingerprint-1",
      "00000000-0000-0000-0000-000000000010",
    );

    seedUpdateManifests([fingerprintBundle]);
    listedObjectPrefixes = [];
    loadedObjectKeys = [];

    await expect(
      plugin.updates?.check(undefined, {
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

    expect(listedObjectPrefixes).toEqual([]);
    expect(loadedObjectKeys).toEqual([
      "production/ios/fingerprint-1/update.json",
    ]);
  });

  it("ignores stale management indexes to avoid missing canonical bundles", async () => {
    const indexedBundle = createBundleJson(
      "production",
      "ios",
      "1.0.0",
      "default-index-A",
    );
    const missingBundle = createBundleJson(
      "production",
      "ios",
      "1.0.0",
      "default-index-B",
    );
    seedUpdateManifests([indexedBundle, missingBundle]);
    seedStaleManagementIndex([indexedBundle]);

    plugin = createPlugin();
    listedObjectPrefixes = [];
    loadedObjectKeys = [];

    const result = await plugin.bundles.list(undefined, { limit: 20 });

    expect(result.data.map((bundle) => bundle.id)).toEqual([
      missingBundle.id,
      indexedBundle.id,
    ]);
    expect(listedObjectPrefixes).toContain("");
    expect(loadedObjectKeys).toEqual(["production/ios/1.0.0/update.json"]);
  });

  it("lists canonical manifests with S3 delimiters instead of broad object scans", async () => {
    const bundle = createBundleJson(
      "production",
      "ios",
      "1.0.0",
      "delimiter-scan-bundle",
    );

    seedUpdateManifests([bundle]);
    fakeStore["production/ios/1.0.0/assets/main.js"] = "asset";
    fakeStore["production/ios/1.0.0/assets/nested/logo.png"] = "asset";
    fakeStore["uploads/delimiter-scan-bundle/bundle.zip"] = "zip";

    plugin = createPlugin();
    listedObjectPrefixes = [];
    listedObjectRequests = [];
    loadedObjectKeys = [];

    await expect(
      plugin.bundles.get(undefined, { id: bundle.id }),
    ).resolves.toStrictEqual(bundle);

    expect(listedObjectRequests).toContainEqual({
      delimiter: "/",
      prefix: "",
    });
    expect(listedObjectRequests).toContainEqual({
      delimiter: "/",
      prefix: "production/",
    });
    expect(listedObjectRequests).toContainEqual({
      delimiter: "/",
      prefix: "production/ios/",
    });
    expect(listedObjectRequests).not.toContainEqual({
      delimiter: "/",
      prefix: "production/ios/1.0.0/assets/",
    });
    expect(loadedObjectKeys).toEqual(["production/ios/1.0.0/update.json"]);
  });

  it("limits recursive S3 manifest listing concurrency", async () => {
    const channelCount = 12;
    const bundles = Array.from({ length: channelCount }, (_, index) =>
      createBundleJson(
        `channel-${String(index).padStart(2, "0")}`,
        "ios",
        "1.0.0",
        `concurrency-bundle-${String(index).padStart(2, "0")}`,
      ),
    );

    seedUpdateManifests(bundles);
    plugin = createPlugin();
    listedObjectPrefixes = [];
    activeListObjectRequests = 0;
    maxActiveListObjectRequests = 0;

    const result = await plugin.bundles.list(undefined, {
      limit: channelCount,
    });

    expect(result.data).toHaveLength(channelCount);
    expect(listedObjectPrefixes).toContain("");
    expect(maxActiveListObjectRequests).toBeLessThanOrEqual(4);
  });

  it("does not write management index artifacts during commits", async () => {
    const newBundle = createBundleJson(
      "production",
      "ios",
      "1.0.0",
      "default-index-commit",
    );

    await plugin.bundles.append(undefined, { data: newBundle });
    await plugin.commit(undefined, {});

    expect(
      Object.keys(fakeStore).filter((key) =>
        key.startsWith(`${MANAGEMENT_INDEX_PREFIX}/`),
      ),
    ).toEqual([]);
  });

  it("uploads database metadata with S3 PutObject instead of multipart upload", async () => {
    const newBundle = createBundleJson(
      "production",
      "ios",
      "1.0.0",
      "put-object-metadata",
    );

    await plugin.bundles.append(undefined, { data: newBundle });
    await plugin.commit(undefined, {});

    expect(putObjectKeys).toEqual([
      "production/ios/1.0.0/update.json",
      "production/ios/target-app-versions.json",
    ]);
  });

  it("updates target app versions without listing S3 during commit", async () => {
    fakeStore["staging/android/2.0.0/update.json"] = JSON.stringify([
      createBundleJson("staging", "android", "2.0.0", "unrelated-android"),
    ]);
    fakeStore["production/android/9.0.0/update.json"] = JSON.stringify([
      createBundleJson("production", "android", "9.0.0", "unrelated-platform"),
    ]);

    const newBundle = createBundleJson(
      "production",
      "ios",
      "1.0.0",
      "scoped-target-version-insert",
    );

    listedObjectPrefixes = [];
    loadedObjectKeys = [];

    await plugin.bundles.append(undefined, { data: newBundle });
    await plugin.commit(undefined, {});

    expect(listedObjectPrefixes).toEqual([]);
    expect(
      JSON.parse(fakeStore["production/ios/target-app-versions.json"]),
    ).toStrictEqual(["1.0.0"]);
  });

  it("updates target app versions for both channels when an app-version bundle moves channels", async () => {
    const movedBundle = createBundleJson(
      "beta",
      "ios",
      "1.0.0",
      "scoped-target-version-move",
    );
    fakeStore["beta/ios/1.0.0/update.json"] = JSON.stringify([movedBundle]);
    fakeStore["beta/ios/target-app-versions.json"] = JSON.stringify(["1.0.0"]);
    fakeStore["production/ios/target-app-versions.json"] = JSON.stringify([]);
    fakeStore["staging/ios/9.9.9/update.json"] = JSON.stringify([
      createBundleJson("staging", "ios", "9.9.9", "unrelated-channel"),
    ]);

    await plugin.bundles.list(undefined, { limit: 20 });
    listedObjectPrefixes = [];
    loadedObjectKeys = [];

    await plugin.bundles.update(undefined, {
      id: movedBundle.id,
      data: {
        channel: "production",
      },
    });
    await plugin.commit(undefined, {});

    expect(listedObjectPrefixes).toEqual([]);
    expect(
      JSON.parse(fakeStore["beta/ios/target-app-versions.json"]),
    ).toStrictEqual([]);
    expect(
      JSON.parse(fakeStore["production/ios/target-app-versions.json"]),
    ).toStrictEqual(["1.0.0"]);
  });

  it("removes target app versions without listing S3 during commit", async () => {
    const removedBundle = createBundleJson(
      "production",
      "ios",
      "1.0.0",
      "target-version-remove",
    );
    fakeStore["production/ios/1.0.0/update.json"] = JSON.stringify([
      removedBundle,
    ]);
    fakeStore["production/ios/target-app-versions.json"] = JSON.stringify([
      "1.0.0",
    ]);

    await plugin.bundles.list(undefined, { limit: 20 });
    listedObjectPrefixes = [];
    loadedObjectKeys = [];

    await deleteBundleById(plugin, undefined, {
      id: removedBundle.id,
      bundle: removedBundle,
    });
    await plugin.commit(undefined, {});

    expect(listedObjectPrefixes).toEqual([]);
    expect(
      JSON.parse(fakeStore["production/ios/target-app-versions.json"]),
    ).toStrictEqual([]);
  });

  it("reads channels from canonical manifests", async () => {
    seedUpdateManifests([
      createBundleJson("production", "ios", "1.0.0", "production-ios-100"),
      createBundleJson("production", "ios", "1.0.1", "production-ios-101"),
      createBundleJson("staging", "android", "1.0.0", "staging-android-100"),
      createBundleJson("staging", "android", "1.0.1", "staging-android-101"),
    ]);
    listedObjectPrefixes = [];
    loadedObjectKeys = [];

    await expect(plugin.channels.getChannels()).resolves.toEqual([
      "production",
      "staging",
    ]);

    expect(listedObjectPrefixes).toContain("");
    expect(loadedObjectKeys.slice().sort()).toEqual(
      [
        "production/ios/1.0.0/update.json",
        "production/ios/1.0.1/update.json",
        "staging/android/1.0.0/update.json",
        "staging/android/1.0.1/update.json",
      ].sort(),
    );
  });

  it("reads bundle detail from canonical manifests", async () => {
    const bundles = createScopedBundles({ count: 70 });
    seedUpdateManifests(bundles);
    listedObjectPrefixes = [];
    loadedObjectKeys = [];

    await expect(
      plugin.bundles.get(undefined, { id: "bundle-005" }),
    ).resolves.toMatchObject({
      id: "bundle-005",
    });

    expect(listedObjectPrefixes).toContain("");
    expect(loadedObjectKeys).toContain("production/ios/1.0.0/update.json");
  });

  it("serves console-style reads from canonical manifests after updating bundle metadata", async () => {
    const targetBundle = createBundleJson(
      "beta",
      "ios",
      "1.0.0",
      "console-update-target",
    );
    const siblingBundle = createBundleJson(
      "production",
      "ios",
      "1.0.0",
      "console-update-sibling",
    );

    await plugin.bundles.append(undefined, { data: targetBundle });
    await plugin.bundles.append(undefined, { data: siblingBundle });
    await plugin.commit(undefined, {});

    await plugin.bundles.update(undefined, {
      id: targetBundle.id,
      data: {
        channel: "production",
        enabled: false,
        message: "Updated from console",
      },
    });
    await plugin.commit(undefined, {});

    plugin = createPlugin();

    listedObjectPrefixes = [];
    loadedObjectKeys = [];

    const updatedBundles = await plugin.bundles.list(undefined, {
      where: { channel: "production", platform: "ios" },
      limit: 20,
    });

    expect(updatedBundles.data).toEqual([
      {
        ...targetBundle,
        channel: "production",
        enabled: false,
        message: "Updated from console",
      },
      siblingBundle,
    ]);
    expect(listedObjectPrefixes).toEqual(["production/ios/"]);
    expect(loadedObjectKeys).toEqual(["production/ios/1.0.0/update.json"]);

    plugin = createPlugin();

    listedObjectPrefixes = [];
    loadedObjectKeys = [];

    await expect(
      plugin.bundles.get(undefined, { id: targetBundle.id }),
    ).resolves.toMatchObject({
      id: targetBundle.id,
      channel: "production",
      enabled: false,
      message: "Updated from console",
    });

    plugin = createPlugin();

    listedObjectPrefixes = [];
    loadedObjectKeys = [];

    await expect(plugin.channels.getChannels()).resolves.toEqual([
      "production",
    ]);

    expect(listedObjectPrefixes).toContain("");
    expect(loadedObjectKeys).toEqual(["production/ios/1.0.0/update.json"]);
  });

  it("serves console-style reads from canonical manifests after deleting bundles", async () => {
    const deletedBundle = createBundleJson(
      "staging",
      "ios",
      "1.0.0",
      "console-delete-target",
    );
    const survivingBundle = createBundleJson(
      "production",
      "ios",
      "1.0.0",
      "console-delete-survivor",
    );

    await plugin.bundles.append(undefined, { data: deletedBundle });
    await plugin.bundles.append(undefined, { data: survivingBundle });
    await plugin.commit(undefined, {});

    await deleteBundleById(plugin, undefined, {
      id: deletedBundle.id,
      bundle: deletedBundle,
    });
    await plugin.commit(undefined, {});

    plugin = createPlugin();

    listedObjectPrefixes = [];
    loadedObjectKeys = [];

    const productionBundles = await plugin.bundles.list(undefined, {
      where: { channel: "production", platform: "ios" },
      limit: 20,
    });

    expect(productionBundles.data).toEqual([survivingBundle]);
    expect(listedObjectPrefixes).toEqual(["production/ios/"]);
    expect(loadedObjectKeys).toEqual(["production/ios/1.0.0/update.json"]);

    plugin = createPlugin();

    listedObjectPrefixes = [];
    loadedObjectKeys = [];

    await expect(plugin.channels.getChannels()).resolves.toEqual([
      "production",
    ]);

    expect(listedObjectPrefixes).toContain("");
    expect(loadedObjectKeys).toEqual(["production/ios/1.0.0/update.json"]);

    plugin = createPlugin();

    listedObjectPrefixes = [];
    loadedObjectKeys = [];

    const removedScopeBundles = await plugin.bundles.list(undefined, {
      where: { channel: "staging", platform: "ios" },
      limit: 20,
    });

    expect(removedScopeBundles.data).toEqual([]);
    expect(listedObjectPrefixes).toEqual(["staging/ios/"]);
    expect(loadedObjectKeys).toEqual([]);
  });

  it("reads canonical manifests when another S3 plugin instance updates bundles", async () => {
    const targetBundle = createBundleJson(
      "staging",
      "ios",
      "1.0.0",
      "stale-list-target",
    );
    const siblingBundle = createBundleJson(
      "staging",
      "ios",
      "1.0.0",
      "stale-list-sibling",
    );

    await plugin.bundles.append(undefined, { data: targetBundle });
    await plugin.bundles.append(undefined, { data: siblingBundle });
    await plugin.commit(undefined, {});

    await plugin.bundles.list(undefined, {
      where: { channel: "staging", platform: "ios" },
      limit: 20,
    });

    const secondPlugin = createPlugin();

    await secondPlugin.bundles.update(undefined, {
      id: targetBundle.id,
      data: {
        enabled: false,
        message: "Updated from another instance",
      },
    });
    await secondPlugin.commit(undefined, {});
    expect(
      JSON.parse(fakeStore["staging/ios/1.0.0/update.json"] ?? "[]"),
    ).toEqual([
      {
        ...targetBundle,
        enabled: false,
        message: "Updated from another instance",
      },
      siblingBundle,
    ]);

    listedObjectPrefixes = [];
    loadedObjectKeys = [];

    const refreshedBundles = await plugin.bundles.list(undefined, {
      where: { channel: "staging", platform: "ios" },
      limit: 20,
    });

    expect(loadedObjectKeys).toEqual(["staging/ios/1.0.0/update.json"]);
    expect(refreshedBundles.data).toEqual([
      {
        ...targetBundle,
        enabled: false,
        message: "Updated from another instance",
      },
      siblingBundle,
    ]);
    expect(listedObjectPrefixes).toEqual(["staging/ios/"]);
    expect(loadedObjectKeys).toEqual(["staging/ios/1.0.0/update.json"]);
  });

  it("reads canonical manifests when another S3 plugin instance changes channels", async () => {
    const stagingBundle = createBundleJson(
      "staging",
      "ios",
      "1.0.0",
      "stale-channel-target",
    );

    await plugin.bundles.append(undefined, { data: stagingBundle });
    await plugin.commit(undefined, {});

    await expect(plugin.channels.getChannels()).resolves.toEqual(["staging"]);

    const secondPlugin = createPlugin();

    const bundleToDelete = await secondPlugin.bundles.get(undefined, {
      id: stagingBundle.id,
    });
    expect(bundleToDelete).toEqual(stagingBundle);
    await deleteBundleById(secondPlugin, undefined, {
      id: bundleToDelete!.id,
      bundle: bundleToDelete!,
    });
    await secondPlugin.commit(undefined, {});

    listedObjectPrefixes = [];
    loadedObjectKeys = [];

    await expect(plugin.channels.getChannels()).resolves.toEqual([]);
    expect(listedObjectPrefixes).toContain("");
    expect(loadedObjectKeys).toEqual([]);
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
    await plugin.bundles.append(undefined, { data: newBundle });
    await plugin.commit(undefined, {});

    // Verify bundle was properly added to update.json file
    const storedBundles = JSON.parse(fakeStore[bundleKey]);
    expect(storedBundles).toStrictEqual([newBundle]);

    // Verify new version was added to target-app-versions.json
    const versions = JSON.parse(fakeStore[targetVersionsKey]);
    expect(versions).toContain("1.0.0");

    // Verify bundle can be retrieved from memory cache
    const fetchedBundle = await plugin.bundles.get(undefined, {
      id: "00000000-0000-0000-0000-000000000001",
    });
    expect(fetchedBundle).toStrictEqual(newBundle);
  });

  it("stores database objects under basePath while exposing logical keys", async () => {
    plugin = createPlugin({ basePath: "/e2e/job-1/ios-s1/" });
    const bundleKey = "production/ios/1.0.0/update.json";
    const namespacedBundleKey = `e2e/job-1/ios-s1/${bundleKey}`;
    const newBundle = createBundleJson(
      "production",
      "ios",
      "1.0.0",
      "00000000-0000-0000-0000-000000000001",
    );

    await plugin.bundles.append(undefined, { data: newBundle });
    await plugin.commit(undefined, {});

    expect(fakeStore[bundleKey]).toBeUndefined();
    expect(JSON.parse(fakeStore[namespacedBundleKey])).toStrictEqual([
      newBundle,
    ]);

    listedObjectPrefixes = [];
    loadedObjectKeys = [];
    plugin = createPlugin({ basePath: "/e2e/job-1/ios-s1/" });

    const fetchedBundles = await plugin.bundles.list(undefined, { limit: 20 });

    expect(fetchedBundles.data).toContainEqual(newBundle);
    expect(loadedObjectKeys.length).toBeGreaterThan(0);
    expect(
      loadedObjectKeys.every((key) => key.startsWith("e2e/job-1/ios-s1/")),
    ).toBe(true);
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
    await plugin.bundles.list(undefined, { limit: 20 });
    await plugin.bundles.update(undefined, {
      id: "00000000-0000-0000-0000-000000000002",
      data: {
        enabled: false,
      },
    });
    await plugin.commit(undefined, {});

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
      plugin.bundles.update(undefined, {
        id: "nonexistent",
        data: { enabled: true },
      }),
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
    await plugin.bundles.list(undefined, { limit: 20 });

    // Update targetAppVersion of one bundle from ios/1.x.x to 1.0.2
    await plugin.bundles.update(undefined, {
      id: "00000000-0000-0000-0000-000000000003",
      data: {
        targetAppVersion: "1.0.2",
      },
    });
    // Commit changes to S3
    await plugin.commit(undefined, {});

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

    await plugin.bundles.list(undefined, { limit: 20 });

    await plugin.bundles.update(undefined, {
      id: "00000000-0000-0000-0000-000000000004",
      data: {
        targetAppVersion: "1.x.x",
      },
    });

    await plugin.bundles.update(undefined, {
      id: "00000000-0000-0000-0000-000000000005",
      data: {
        targetAppVersion: "1.x.x",
      },
    });
    // Commit changes to S3
    await plugin.commit(undefined, {});

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
    const bundles = await plugin.bundles.list(undefined, { limit: 20 });

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
    const bundles = await plugin.bundles.list(undefined, { limit: 20 });

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
    await plugin.bundles.update(undefined, {
      id: "beta-ios-1",
      data: {
        enabled: false,
        message: "Disabled in beta channel",
      },
    });
    await plugin.commit(undefined, {});

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
    await plugin.bundles.list(undefined, { limit: 20 });
    await plugin.bundles.update(undefined, {
      id: "channel-move-test",
      data: {
        channel: "production",
      },
    });
    await plugin.commit(undefined, {});

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
    const bundle = await plugin.bundles.get(undefined, {
      id: "non-existent-id",
    });
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

    await plugin.bundles.append(undefined, { data: bundle1 });
    await plugin.bundles.append(undefined, { data: bundle2 });
    await plugin.bundles.append(undefined, { data: bundle3 });
    await plugin.commit(undefined, {});

    const result = await plugin.bundles.list(undefined, {
      where: { channel: "production" },
      limit: 20,
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

    await plugin.bundles.append(undefined, { data: bundle1 });
    await plugin.bundles.append(undefined, { data: bundle2 });
    await plugin.bundles.append(undefined, { data: bundle3 });
    await plugin.commit(undefined, {});

    const firstPage = await plugin.bundles.list(undefined, {
      where: { channel: "production" },
      limit: 2,
    });

    expect(firstPage.data).toHaveLength(2);
    expect(firstPage.pagination).toEqual({
      total: 3,
      hasNextPage: true,
      hasPreviousPage: false,
      currentPage: 1,
      totalPages: 2,
      nextCursor: "bundle2",
    });

    const secondPage = await plugin.bundles.list(undefined, {
      where: { channel: "production" },
      limit: 2,
      cursor: {
        after: firstPage.pagination.nextCursor ?? undefined,
      },
    });

    expect(secondPage.data).toHaveLength(1);
    expect(secondPage.pagination).toEqual({
      total: 3,
      hasNextPage: false,
      hasPreviousPage: true,
      currentPage: 2,
      totalPages: 2,
      previousCursor: "bundle1",
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

    // Call commit but update.json should remain unchanged as no bundles were modified
    await plugin.commit(undefined, {});

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
    )();
    const bundle = createBundleJson("production", "ios", "1.0.0", "hook-test");
    await pluginWithHook.bundles.append(undefined, { data: bundle });
    await pluginWithHook.commit(undefined, {});
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

    const bundles = await plugin.bundles.list(undefined, { limit: 20 });

    // Descending order: "C" > "B" > "A"
    expect(bundles.data).toEqual([bundleC, bundleB, bundleA]);
  });

  it("skips archived stale update manifests while rebuilding from SSOT", async () => {
    const archivedUpdateKey = "production/ios/0.9.0/update.json";
    const activeUpdateKey = "production/ios/1.0.0/update.json";
    const archivedBundle = createBundleJson(
      "production",
      "ios",
      "0.9.0",
      "archived-update-json",
    );
    const activeBundle = createBundleJson(
      "production",
      "ios",
      "1.0.0",
      "active-update-json",
    );
    fakeStore[archivedUpdateKey] = JSON.stringify([archivedBundle]);
    fakeStore[activeUpdateKey] = JSON.stringify([activeBundle]);
    archivedObjectKeys.set(archivedUpdateKey, "GLACIER");
    loadedObjectKeys = [];

    const bundles = await plugin.bundles.list(undefined, { limit: 20 });

    expect(bundles.data).toEqual([activeBundle]);
    expect(loadedObjectKeys).toEqual([archivedUpdateKey, activeUpdateKey]);
  });

  it("skips archived app-version manifests during update checks", async () => {
    const archivedUpdateKey = "production/ios/*/update.json";
    const activeUpdateKey = "production/ios/1.0.0/update.json";
    const archivedBundle = createBundleJson(
      "production",
      "ios",
      "*",
      "00000000-0000-0000-0000-000000000002",
    );
    const activeBundle = createBundleJson(
      "production",
      "ios",
      "1.0.0",
      "00000000-0000-0000-0000-000000000001",
    );
    fakeStore["production/ios/target-app-versions.json"] = JSON.stringify([
      "*",
      "1.0.0",
    ]);
    fakeStore[archivedUpdateKey] = JSON.stringify([archivedBundle]);
    fakeStore[activeUpdateKey] = JSON.stringify([activeBundle]);
    archivedObjectKeys.set(archivedUpdateKey, "GLACIER");
    loadedObjectKeys = [];

    await expect(
      plugin.updates?.check(undefined, {
        _updateStrategy: "appVersion",
        appVersion: "1.0.0",
        bundleId: "00000000-0000-0000-0000-000000000000",
        platform: "ios",
      }),
    ).resolves.toEqual({
      fileHash: activeBundle.fileHash,
      id: activeBundle.id,
      message: activeBundle.message,
      shouldForceUpdate: activeBundle.shouldForceUpdate,
      status: "UPDATE",
      storageUri: activeBundle.storageUri,
    });
    expect(loadedObjectKeys[0]).toBe("production/ios/target-app-versions.json");
    expect(new Set(loadedObjectKeys.slice(1))).toEqual(
      new Set([archivedUpdateKey, activeUpdateKey]),
    );
  });

  it("treats archived direct S3 metadata reads as missing", async () => {
    const updateKey = "production/ios/fingerprint-1/update.json";
    const bundle = createBundleJsonFingerprint(
      "production",
      "ios",
      "fingerprint-1",
      "archived-update-json",
    );
    fakeStore[updateKey] = JSON.stringify([bundle]);
    archivedObjectKeys.set(updateKey, "GLACIER");

    await expect(
      plugin.updates?.check(undefined, {
        _updateStrategy: "fingerprint",
        bundleId: "00000000-0000-0000-0000-000000000000",
        fingerprintHash: "fingerprint-1",
        platform: "ios",
      }),
    ).resolves.toBeNull();
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
    await plugin.bundles.list(undefined, { limit: 20 });
    const fetchedBundle = await plugin.bundles.get(undefined, {
      id: "internal-test",
    });
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
    await plugin.bundles.append(undefined, { data: bundle });
    // Change only enabled property → path should remain the same
    await plugin.bundles.update(undefined, {
      id: "same-key-test",
      data: { enabled: false },
    });
    await plugin.commit(undefined, {});

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
    const bundles = await plugin.bundles.list(undefined, { limit: 20 });
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

    await plugin.bundles.append(undefined, { data: bundle1 });
    await plugin.bundles.append(undefined, { data: bundle2 });
    await plugin.commit(undefined, {});

    const iosUpdateKey = "production/ios/1.0.0/update.json";
    const androidUpdateKey = "production/android/2.0.0/update.json";

    const iosBundles = JSON.parse(fakeStore[iosUpdateKey]);
    const androidBundles = JSON.parse(fakeStore[androidUpdateKey]);

    expect(iosBundles).toEqual([bundle1]);
    expect(androidBundles).toEqual([bundle2]);
  });

  it("should not update S3 until commit is called", async () => {
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
    await plugin.bundles.append(undefined, { data: newBundle });

    // S3 should remain unchanged until commit is called
    expect(Object.keys(fakeStore)).toHaveLength(0);

    // Now after calling commit, update.json file should be created in S3 (fakeStore)
    await plugin.commit(undefined, {});
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
    const bundles = await plugin.bundles.list(undefined, {
      limit: 10,
      where: {
        platform: undefined,
        channel: "production",
      },
    });

    // Assert: Both bundles should be loaded
    expect(bundles.data).toHaveLength(3);
    expect(bundles.data).toEqual([iosBundle2, androidBundle, iosBundle]);

    // Sanity check: getBundleById works for both
    const foundIos = await plugin.bundles.get(undefined, {
      id: "00000000-0000-0000-0000-000000000010",
    });
    const foundAndroid = await plugin.bundles.get(undefined, {
      id: "00000000-0000-0000-0000-000000000011",
    });
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
    await plugin.bundles.append(undefined, { data: newBundle });

    await plugin.commit(undefined, {});

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
    await plugin.bundles.append(undefined, { data: bundle });
    await plugin.commit(undefined, {});

    cloudfrontInvalidations = [];

    await plugin.bundles.update(undefined, {
      id: "cloudfront-update-test",
      data: {
        enabled: false,
      },
    });
    await plugin.commit(undefined, {});

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

  it("should not trigger CloudFront invalidation when commit is called with no pending changes", async () => {
    cloudfrontInvalidations = [];

    await plugin.commit(undefined, {});

    expect(cloudfrontInvalidations.length).toBe(0);
  });

  it("should warn and continue when CloudFront invalidation fails", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const bundleKey = "production/ios/1.0.0/update.json";
    const targetVersionsKey = "production/ios/target-app-versions.json";
    const newBundle = createBundleJson(
      "production",
      "ios",
      "1.0.0",
      "cloudfront-warning-test",
    );

    cloudfrontInvalidationError = new Error("TooManyInvalidationsInProgress");

    await plugin.bundles.append(undefined, { data: newBundle });
    await expect(plugin.commit(undefined, {})).resolves.toBeUndefined();

    expect(JSON.parse(fakeStore[bundleKey])).toStrictEqual([newBundle]);
    expect(JSON.parse(fakeStore[targetVersionsKey])).toContain("1.0.0");
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain(
      "CloudFront invalidation failed",
    );
  });

  it("should wait for CloudFront invalidation completion when enabled", async () => {
    vi.useFakeTimers();
    const waitingPlugin = s3Database({
      bucketName,
      ...s3Config,
      cloudfrontDistributionId: "test-distribution-id",
      shouldWaitForInvalidation: true,
    })();
    const newBundle = createBundleJson(
      "production",
      "ios",
      "1.0.0",
      "cloudfront-wait-test",
    );

    nextCloudfrontInvalidationStatuses = ["InProgress", "Completed"];

    await waitingPlugin.bundles.append(undefined, { data: newBundle });
    const commitPromise = waitingPlugin.commit(undefined, {});
    await vi.runAllTimersAsync();
    await expect(commitPromise).resolves.toBeUndefined();
    expect(cloudfrontGetInvalidationCalls).toContain("invalidation-1");
  });

  it("should fail when waiting for CloudFront invalidation times out", async () => {
    vi.useFakeTimers();
    const waitingPlugin = s3Database({
      bucketName,
      ...s3Config,
      cloudfrontDistributionId: "test-distribution-id",
      shouldWaitForInvalidation: true,
    })();
    const newBundle = createBundleJson(
      "production",
      "ios",
      "1.0.0",
      "cloudfront-timeout-test",
    );

    nextCloudfrontInvalidationStatuses = ["InProgress"];

    await waitingPlugin.bundles.append(undefined, { data: newBundle });
    const commitPromise = waitingPlugin.commit(undefined, {});
    const assertion = expect(commitPromise).rejects.toThrow(
      "Timed out waiting for CloudFront invalidation invalidation-1 to complete",
    );
    await vi.runAllTimersAsync();
    await assertion;
  });

  it("should trigger CloudFront invalidation for fingerprint path when bundle is updated", async () => {
    const bundle = createBundleJsonFingerprint(
      "production",
      "ios",
      "abcdef000",
      "fingerprint-test",
    );
    await plugin.bundles.append(undefined, { data: bundle });
    await plugin.commit(undefined, {});

    cloudfrontInvalidations = [];

    await plugin.bundles.update(undefined, {
      id: "fingerprint-test",
      data: { enabled: false },
    });
    await plugin.commit(undefined, {});

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
      "/api/check-update/fingerprint/ios/abcdef000/production/*",
    );
    expect(invalidatedPaths).not.toContain(
      "/api/check-update/app-version/ios/1.0.0/production/*",
    );
  });
});
