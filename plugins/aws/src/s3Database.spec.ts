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
  S3Client,
} from "@aws-sdk/client-s3";
import type { Bundle } from "@hot-updater/plugin-core";
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
const MANAGEMENT_INDEX_VERSION = 1;
const MANAGEMENT_INDEX_PAGE_SIZE = 64;

type ManagementScope = {
  channel?: string;
  platform?: "ios" | "android";
};

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
let loadedObjectKeys: string[] = [];

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
  loadedObjectKeys = [];
  vi.spyOn(S3Client.prototype, "send").mockImplementation(
    async (command: any) => {
      await delay(5);
      if (command instanceof ListObjectsV2Command) {
        const prefix = command.input.Prefix ?? "";
        listedObjectPrefixes.push(prefix);
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
        if (key) {
          loadedObjectKeys.push(key);
        }
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
      managementIndexPageSize: MANAGEMENT_INDEX_PAGE_SIZE,
      ...config,
    })();

  let plugin = createPlugin({
    managementIndexPageSize: MANAGEMENT_INDEX_PAGE_SIZE,
  });

  beforeEach(async () => {
    plugin = createPlugin({
      managementIndexPageSize: MANAGEMENT_INDEX_PAGE_SIZE,
    });
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

  setupBundleMethodsTestSuite({
    getBundleById: (id) => plugin.getBundleById(id),
    getChannels: () => plugin.getChannels(),
    insertBundle: async (bundle) => {
      await plugin.appendBundle(bundle);
      await plugin.commitBundle();
    },
    getBundles: (options) => plugin.getBundles(options),
    updateBundleById: async (bundleId, newBundle) => {
      await plugin.updateBundle(bundleId, newBundle);
      await plugin.commitBundle();
    },
    deleteBundleById: async (bundleId) => {
      const bundle = await plugin.getBundleById(bundleId);
      if (!bundle) {
        return;
      }
      await plugin.deleteBundle(bundle);
      await plugin.commitBundle();
    },
  });

  beforeEach(() => {
    fakeStore = {};
    listedObjectPrefixes = [];
    loadedObjectKeys = [];
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

    expect(listedObjectPrefixes).toEqual([]);
    expect(loadedObjectKeys).toEqual([
      "production/ios/fingerprint-1/update.json",
    ]);
  });

  it("reads the first all-bundles page from one root and one leaf page", async () => {
    const bundles = createScopedBundles({ count: 70 });
    seedPagedBundlesIndex(bundles);
    listedObjectPrefixes = [];
    loadedObjectKeys = [];

    const result = await plugin.getBundles({ limit: 20 });

    expect(result.data.map((bundle) => bundle.id)).toEqual(
      bundles.slice(0, 20).map((bundle) => bundle.id),
    );
    expect(listedObjectPrefixes).toEqual([]);
    expect(loadedObjectKeys).toEqual([
      getManagementRootKey({}),
      getManagementPageKey({}, 0),
    ]);
  });

  it("uses a custom management index page size from s3Database config", async () => {
    const bundles = createScopedBundles({ count: 5 });
    seedUpdateManifests(bundles);

    plugin = createPlugin({ managementIndexPageSize: 2 });

    await plugin.getBundles({ limit: 5 });

    expect(JSON.parse(fakeStore[getManagementRootKey({})]!)).toMatchObject({
      pageSize: 2,
    });
    expect(fakeStore[getManagementPageKey({}, 2)]).toBeDefined();
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
    "reads warm filtered bundles with minimal S3 objects for $label",
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
      listedObjectPrefixes = [];
      loadedObjectKeys = [];

      await plugin.getBundles({
        where,
        limit: 20,
        cursor: {
          after: "bundle-999",
        },
      });

      expect(listedObjectPrefixes).toEqual([]);
      expect(loadedObjectKeys).toEqual(expectedKeys);
    },
  );

  it("reads at most two leaf pages when an after cursor crosses a page boundary", async () => {
    const bundles = createScopedBundles({ count: 70 });
    seedPagedBundlesIndex(bundles);
    listedObjectPrefixes = [];
    loadedObjectKeys = [];

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
    expect(listedObjectPrefixes).toEqual([]);
    expect(loadedObjectKeys).toEqual([
      getManagementRootKey({ channel: "production", platform: "ios" }),
      getManagementPageKey({ channel: "production", platform: "ios" }, 0),
      getManagementPageKey({ channel: "production", platform: "ios" }, 1),
    ]);
  });

  it("reads at most two leaf pages when a before cursor crosses a page boundary", async () => {
    const bundles = createScopedBundles({ count: 70 });
    seedPagedBundlesIndex(bundles);
    listedObjectPrefixes = [];
    loadedObjectKeys = [];

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
    expect(listedObjectPrefixes).toEqual([]);
    expect(loadedObjectKeys).toEqual([
      getManagementRootKey({ channel: "production", platform: "ios" }),
      getManagementPageKey({ channel: "production", platform: "ios" }, 1),
      getManagementPageKey({ channel: "production", platform: "ios" }, 0),
    ]);
  });

  it("keeps page-aligned results stable when a stale cursor is combined with page=2", async () => {
    const bundles = createScopedBundles({ count: 121 });
    seedPagedBundlesIndex(bundles);
    listedObjectPrefixes = [];
    loadedObjectKeys = [];

    const result = await plugin.getBundles({
      where: { channel: "production", platform: "ios" },
      limit: 20,
      page: 2,
      cursor: {
        after: "bundle-110",
      },
    });

    expect(result.data.map((bundle) => bundle.id)).toEqual(
      Array.from(
        { length: 20 },
        (_, index) => `bundle-${String(101 - index).padStart(3, "0")}`,
      ),
    );
    expect(result.pagination.currentPage).toBe(2);
    expect(result.pagination.previousCursor).toBe("bundle-101");
    expect(result.pagination.nextCursor).toBe("bundle-082");
    expect(loadedObjectKeys).toEqual([
      getManagementRootKey({ channel: "production", platform: "ios" }),
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
    listedObjectPrefixes = [];
    loadedObjectKeys = [];

    await expect(plugin.getChannels()).resolves.toEqual([
      "production",
      "staging",
    ]);

    expect(listedObjectPrefixes).toEqual([]);
    expect(loadedObjectKeys).toEqual([getManagementRootKey({})]);
  });

  it("reads bundle detail from the all-bundles root and one leaf page", async () => {
    const bundles = createScopedBundles({ count: 70 });
    seedPagedBundlesIndex(bundles);
    listedObjectPrefixes = [];
    loadedObjectKeys = [];

    await expect(plugin.getBundleById("bundle-005")).resolves.toMatchObject({
      id: "bundle-005",
    });

    expect(listedObjectPrefixes).toEqual([]);
    expect(loadedObjectKeys).toEqual([
      getManagementRootKey({}),
      getManagementPageKey({}, 1),
    ]);
  });

  it("serves console-style reads from rebuilt paged indexes after updating bundle metadata", async () => {
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

    await plugin.appendBundle(targetBundle);
    await plugin.appendBundle(siblingBundle);
    await plugin.commitBundle();

    await plugin.updateBundle(targetBundle.id, {
      channel: "production",
      enabled: false,
      message: "Updated from console",
    });
    await plugin.commitBundle();

    plugin = createPlugin();

    listedObjectPrefixes = [];
    loadedObjectKeys = [];

    const updatedBundles = await plugin.getBundles({
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
    expect(listedObjectPrefixes).toEqual([]);
    expect(loadedObjectKeys).toEqual([
      getManagementRootKey({ channel: "production", platform: "ios" }),
      getManagementPageKey({ channel: "production", platform: "ios" }, 0),
    ]);

    plugin = createPlugin();

    listedObjectPrefixes = [];
    loadedObjectKeys = [];

    await expect(plugin.getBundleById(targetBundle.id)).resolves.toMatchObject({
      id: targetBundle.id,
      channel: "production",
      enabled: false,
      message: "Updated from console",
    });

    expect(listedObjectPrefixes).toEqual([]);
    expect(loadedObjectKeys).toEqual([
      getManagementRootKey({}),
      getManagementPageKey({}, 0),
    ]);

    plugin = createPlugin();

    listedObjectPrefixes = [];
    loadedObjectKeys = [];

    await expect(plugin.getChannels()).resolves.toEqual(["production"]);

    expect(listedObjectPrefixes).toEqual([]);
    expect(loadedObjectKeys).toEqual([getManagementRootKey({})]);
  });

  it("serves console-style reads from rebuilt paged indexes after deleting bundles", async () => {
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

    await plugin.appendBundle(deletedBundle);
    await plugin.appendBundle(survivingBundle);
    await plugin.commitBundle();

    await plugin.deleteBundle(deletedBundle);
    await plugin.commitBundle();

    plugin = createPlugin();

    listedObjectPrefixes = [];
    loadedObjectKeys = [];

    const productionBundles = await plugin.getBundles({
      where: { channel: "production", platform: "ios" },
      limit: 20,
    });

    expect(productionBundles.data).toEqual([survivingBundle]);
    expect(listedObjectPrefixes).toEqual([]);
    expect(loadedObjectKeys).toEqual([
      getManagementRootKey({ channel: "production", platform: "ios" }),
      getManagementPageKey({ channel: "production", platform: "ios" }, 0),
    ]);

    plugin = createPlugin();

    listedObjectPrefixes = [];
    loadedObjectKeys = [];

    await expect(plugin.getChannels()).resolves.toEqual(["production"]);

    expect(listedObjectPrefixes).toEqual([]);
    expect(loadedObjectKeys).toEqual([getManagementRootKey({})]);

    plugin = createPlugin();

    listedObjectPrefixes = [];
    loadedObjectKeys = [];

    const removedScopeBundles = await plugin.getBundles({
      where: { channel: "staging", platform: "ios" },
      limit: 20,
    });

    expect(removedScopeBundles.data).toEqual([]);
    expect(listedObjectPrefixes).toEqual([]);
    expect(loadedObjectKeys.every((key) => key.endsWith("/root.json"))).toBe(
      true,
    );
    expect(loadedObjectKeys).toContain(
      getManagementRootKey({ channel: "staging", platform: "ios" }),
    );
    expect(loadedObjectKeys).toContain(getManagementRootKey({}));
  });

  it("revalidates cached management roots when another S3 plugin instance updates bundles", async () => {
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

    await plugin.appendBundle(targetBundle);
    await plugin.appendBundle(siblingBundle);
    await plugin.commitBundle();

    await plugin.getBundles({
      where: { channel: "staging", platform: "ios" },
      limit: 20,
    });

    const secondPlugin = createPlugin();

    await secondPlugin.updateBundle(targetBundle.id, {
      enabled: false,
      message: "Updated from another instance",
    });
    await secondPlugin.commitBundle();

    listedObjectPrefixes = [];
    loadedObjectKeys = [];

    const refreshedBundles = await plugin.getBundles({
      where: { channel: "staging", platform: "ios" },
      limit: 20,
    });

    expect(refreshedBundles.data).toEqual([
      {
        ...targetBundle,
        enabled: false,
        message: "Updated from another instance",
      },
      siblingBundle,
    ]);
    expect(listedObjectPrefixes).toEqual([]);
    expect(loadedObjectKeys).toEqual([
      getManagementRootKey({ channel: "staging", platform: "ios" }),
      getManagementPageKey({ channel: "staging", platform: "ios" }, 0),
    ]);
  });

  it("revalidates cached management roots when another S3 plugin instance changes channels", async () => {
    const stagingBundle = createBundleJson(
      "staging",
      "ios",
      "1.0.0",
      "stale-channel-target",
    );

    await plugin.appendBundle(stagingBundle);
    await plugin.commitBundle();

    await expect(plugin.getChannels()).resolves.toEqual(["staging"]);

    const secondPlugin = createPlugin();

    const bundleToDelete = await secondPlugin.getBundleById(stagingBundle.id);
    expect(bundleToDelete).toEqual(stagingBundle);
    await secondPlugin.deleteBundle(bundleToDelete!);
    await secondPlugin.commitBundle();

    listedObjectPrefixes = [];
    loadedObjectKeys = [];

    await expect(plugin.getChannels()).resolves.toEqual([]);
    expect(listedObjectPrefixes).toEqual([]);
    expect(loadedObjectKeys).toEqual([getManagementRootKey({})]);
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
    await plugin.getBundles({ limit: 20 });
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
    await plugin.getBundles({ limit: 20 });

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

    await plugin.getBundles({ limit: 20 });

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
    const bundles = await plugin.getBundles({ limit: 20 });

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
    const bundles = await plugin.getBundles({ limit: 20 });

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
    await plugin.getBundles({ limit: 20 });
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

    const secondPage = await plugin.getBundles({
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
    )();
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

    const bundles = await plugin.getBundles({ limit: 20 });

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
    await plugin.getBundles({ limit: 20 });
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
    const bundles = await plugin.getBundles({ limit: 20 });
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

    await plugin.appendBundle(newBundle);
    await expect(plugin.commitBundle()).resolves.toBeUndefined();

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

    await waitingPlugin.appendBundle(newBundle);
    const commitPromise = waitingPlugin.commitBundle();
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

    await waitingPlugin.appendBundle(newBundle);
    const commitPromise = waitingPlugin.commitBundle();
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
    await plugin.appendBundle(bundle);
    await plugin.commitBundle();

    cloudfrontInvalidations = [];

    await plugin.updateBundle("fingerprint-test", { enabled: false });
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
      "/api/check-update/fingerprint/ios/abcdef000/production/*",
    );
    expect(invalidatedPaths).not.toContain(
      "/api/check-update/app-version/ios/1.0.0/production/*",
    );
  });
});
