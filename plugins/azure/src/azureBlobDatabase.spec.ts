import { Buffer } from "buffer";

import type { Bundle } from "@hot-updater/plugin-core";
import { setupBundleMethodsTestSuite } from "@hot-updater/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type AzureBlobDatabaseConfig,
  azureBlobDatabase,
} from "./azureBlobDatabase";

const delay = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

const DEFAULT_BUNDLE: Omit<
  Bundle,
  "id" | "platform" | "targetAppVersion" | "channel"
> = {
  fileHash: "hash",
  gitCommitHash: null,
  message: null,
  enabled: true,
  shouldForceUpdate: false,
  storageUri: "azure-blob://test-container/test-key",
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

const MANAGEMENT_INDEX_PREFIX = "_index";
const MANAGEMENT_INDEX_VERSION = 1;
const MANAGEMENT_INDEX_PAGE_SIZE = 64;

type ManagementScope = {
  channel?: string;
  platform?: "ios" | "android";
};

let fakeStore: Record<string, string> = {};

vi.mock("@azure/storage-blob", () => {
  const createMockContainerClient = () => ({
    getBlobClient: (key: string) => ({
      download: async () => {
        await delay(5);
        if (fakeStore[key] === undefined) {
          const error: any = new Error("BlobNotFound");
          error.statusCode = 404;
          throw error;
        }
        return {
          readableStreamBody: {
            on(event: string, handler: any) {
              if (event === "data") {
                handler(Buffer.from(fakeStore[key]));
              }
              if (event === "end") {
                setTimeout(handler, 0);
              }
            },
          },
        };
      },
      delete: async () => {
        await delay(5);
        delete fakeStore[key];
      },
    }),
    getBlockBlobClient: (key: string) => ({
      upload: async (body: string, _byteLength: number) => {
        await delay(5);
        fakeStore[key] = body;
      },
    }),
    listBlobsFlat: ({ prefix }: { prefix: string }) => ({
      [Symbol.asyncIterator]: async function* () {
        for (const key of Object.keys(fakeStore)) {
          if (key.startsWith(prefix)) {
            yield { name: key };
          }
        }
      },
    }),
  });

  return {
    BlobServiceClient: class {
      static fromConnectionString() {
        return {
          getContainerClient: () => createMockContainerClient(),
        };
      }
      constructor() {
        return {
          getContainerClient: () => createMockContainerClient(),
        };
      }
    },
    ContainerClient: class {},
    StorageSharedKeyCredential: class {
      constructor(
        public accountName: string,
        public accountKey: string,
      ) {}
    },
  };
});

vi.mock("mime", () => ({
  default: {
    getType: () => "application/json",
  },
}));

beforeEach(() => {
  fakeStore = {};
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("azureBlobDatabase plugin", () => {
  const createPlugin = (config: Partial<AzureBlobDatabaseConfig> = {}) =>
    azureBlobDatabase({
      connectionString:
        "DefaultEndpointsProtocol=https;AccountName=test;AccountKey=abc123;EndpointSuffix=core.windows.net",
      containerName: "test-container",
      managementIndexPageSize: MANAGEMENT_INDEX_PAGE_SIZE,
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
      if (!target) continue;

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
      if (!options?.includeChannels && scopedBundles.length === 0) return;

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
        (b) => b.channel === channel,
      );
      addScope({ channel }, channelBundles);
      for (const platform of ["ios", "android"] as const) {
        addScope(
          { channel, platform },
          channelBundles.filter((b) => b.platform === platform),
        );
      }
    }

    for (const platform of ["ios", "android"] as const) {
      addScope(
        { platform },
        sortedBundles.filter((b) => b.platform === platform),
      );
    }
  };

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
      if (!bundle) return;
      await plugin.deleteBundle(bundle);
      await plugin.commitBundle();
    },
  });

  beforeEach(() => {
    fakeStore = {};
    plugin = createPlugin();
  });

  it("uses direct app-version manifests for update checks", async () => {
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

    const updateInfo = await plugin.getUpdateInfo?.({
      _updateStrategy: "appVersion",
      appVersion: "1.0.0",
      bundleId: "00000000-0000-0000-0000-000000000000",
      platform: "ios",
      channel: "production",
    });

    expect(updateInfo).not.toBeNull();
    expect(updateInfo!.id).toBe("00000000-0000-0000-0000-000000000002");
    expect(updateInfo!.status).toBe("UPDATE");
  });

  it("handles empty container gracefully", async () => {
    const bundles = await plugin.getBundles({
      limit: 10,
      where: { channel: "production", platform: "ios" },
    });

    expect(bundles.data).toEqual([]);
    expect(bundles.pagination.total).toBe(0);
  });

  it("reads bundles from seeded management index", async () => {
    const bundle1 = createBundleJson(
      "production",
      "ios",
      "1.0.0",
      "00000000-0000-0000-0000-000000000002",
    );
    const bundle2 = createBundleJson(
      "production",
      "ios",
      "1.0.0",
      "00000000-0000-0000-0000-000000000001",
    );

    seedUpdateManifests([bundle1, bundle2]);
    seedPagedBundlesIndex([bundle1, bundle2]);

    const result = await plugin.getBundles({
      limit: 10,
      where: { channel: "production", platform: "ios" },
    });

    expect(result.data).toHaveLength(2);
    expect(result.data[0].id).toBe("00000000-0000-0000-0000-000000000002");
    expect(result.data[1].id).toBe("00000000-0000-0000-0000-000000000001");
  });

  it("returns null for non-existent bundle", async () => {
    const result = await plugin.getBundleById("nonexistent-id");
    expect(result).toBeNull();
  });

  it("inserts and retrieves a bundle", async () => {
    const bundle = createBundleJson(
      "production",
      "ios",
      "1.0.0",
      "00000000-0000-0000-0000-000000000010",
    );

    await plugin.appendBundle(bundle);
    await plugin.commitBundle();

    const retrieved = await plugin.getBundleById(bundle.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe(bundle.id);
    expect(retrieved!.channel).toBe("production");
    expect(retrieved!.platform).toBe("ios");
  });

  it("invalidatePaths is a no-op by default", async () => {
    const bundle = createBundleJson(
      "production",
      "ios",
      "1.0.0",
      "00000000-0000-0000-0000-000000000020",
    );

    await plugin.appendBundle(bundle);
    await expect(plugin.commitBundle()).resolves.toBeUndefined();
  });
});
