import { PGlite } from "@electric-sql/pglite";
import type { Bundle, GetBundlesArgs, UpdateInfo } from "@hot-updater/core";
import { NIL_UUID } from "@hot-updater/core";
import type {
  StoragePlugin,
  StorageResolveContext,
} from "@hot-updater/plugin-core";
import { createDatabasePlugin } from "@hot-updater/plugin-core";
import {
  setupBundleMethodsTestSuite,
  setupGetUpdateInfoTestSuite,
} from "@hot-updater/test-utils";
import { Kysely } from "kysely";
import { PGliteDialect } from "kysely-pglite-dialect";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { kyselyAdapter } from "../adapters/kysely";
import { createHotUpdater } from "./index";

function createTestStoragePlugin(
  protocol: string,
  resolveFileUrl: (
    storageUri: string,
    context?: StorageResolveContext,
  ) => string,
): StoragePlugin {
  return {
    name: `${protocol}TestStorage`,
    supportedProtocol: protocol,
    async upload(key) {
      return {
        storageUri: `${protocol}://test-bucket/${key}`,
      };
    },
    async delete() {},
    async getDownloadUrl(storageUri, context) {
      return { fileUrl: resolveFileUrl(storageUri, context) };
    },
  };
}

describe("server/db hotUpdater getUpdateInfo (PGlite + Kysely)", async () => {
  const db = new PGlite();

  const kysely = new Kysely({ dialect: new PGliteDialect(db) });

  const hotUpdater = createHotUpdater({
    database: kyselyAdapter({
      db: kysely,
      provider: "postgresql",
    }),
    storages: [
      createTestStoragePlugin("s3", (storageUri) =>
        storageUri
          .replace("s3://", "https://s3.example.com/")
          .replace(/([^:]\/)\/+/g, "$1"),
      ),
      createTestStoragePlugin("r2", (storageUri) =>
        storageUri
          .replace("r2://", "https://r2.example.com/")
          .replace(/([^:]\/)\/+/g, "$1"),
      ),
      createTestStoragePlugin("supabase-storage", (storageUri) =>
        storageUri
          .replace(
            "supabase-storage://",
            "https://supabase.example.com/storage/v1/object/sign/",
          )
          .replace(/([^:]\/)\/+/g, "$1"),
      ),
      createTestStoragePlugin("gs", (storageUri) =>
        storageUri
          .replace("gs://", "https://firebase.example.com/")
          .replace(/([^:]\/)\/+/g, "$1"),
      ),
    ],
  });

  beforeAll(async () => {
    // Initialize FumaDB schema to latest (creates tables under the hood)
    const migrator = hotUpdater.createMigrator();
    const result = await migrator.migrateToLatest({
      mode: "from-schema",
      updateSettings: true,
    });
    await result.execute();
  });

  beforeEach(async () => {
    await db.exec("DELETE FROM bundles");
  });

  afterAll(async () => {
    await kysely.destroy();
    await db.close();
  });

  const getUpdateInfo = async (
    bundles: Bundle[],
    options: GetBundlesArgs,
  ): Promise<UpdateInfo | null> => {
    // Insert fixtures via the server API to exercise its types + mapping
    for (const b of bundles) {
      await hotUpdater.insertBundle(b);
    }
    return hotUpdater.getUpdateInfo(options);
  };

  setupGetUpdateInfoTestSuite({ getUpdateInfo });
  setupBundleMethodsTestSuite({
    getBundleById: hotUpdater.getBundleById.bind(hotUpdater),
    getChannels: hotUpdater.getChannels.bind(hotUpdater),
    insertBundle: hotUpdater.insertBundle.bind(hotUpdater),
    getBundles: hotUpdater.getBundles.bind(hotUpdater),
    updateBundleById: hotUpdater.updateBundleById.bind(hotUpdater),
    deleteBundleById: hotUpdater.deleteBundleById.bind(hotUpdater),
  });

  describe("getBundleById", () => {
    it("should retrieve bundle by id without Prisma validation errors", async () => {
      const bundle: Bundle = {
        id: "00000000-0000-0000-0000-000000000010",
        platform: "ios",
        shouldForceUpdate: false,
        enabled: true,
        fileHash: "test-hash",
        gitCommitHash: null,
        message: "Test bundle for getBundleById",
        channel: "production",
        storageUri: "s3://test-bucket/test.zip",
        targetAppVersion: "1.0.0",
        fingerprintHash: null,
      };

      await hotUpdater.insertBundle(bundle);

      // This should not throw a Prisma validation error
      const retrieved = await hotUpdater.getBundleById(bundle.id);

      expect(retrieved).not.toBeNull();
      expect(retrieved?.id).toBe(bundle.id);
      expect(retrieved?.platform).toBe(bundle.platform);
      expect(retrieved?.fileHash).toBe(bundle.fileHash);
    });

    it("should return null for non-existent bundle id", async () => {
      const retrieved = await hotUpdater.getBundleById(
        "99999999-9999-9999-9999-999999999999",
      );

      expect(retrieved).toBeNull();
    });
  });

  describe("getChannels", () => {
    it("should retrieve all unique channels without Prisma validation errors", async () => {
      const bundles: Bundle[] = [
        {
          id: "00000000-0000-0000-0000-000000000020",
          platform: "ios",
          shouldForceUpdate: false,
          enabled: true,
          fileHash: "hash1",
          gitCommitHash: null,
          message: "Bundle 1",
          channel: "production",
          storageUri: "s3://test/1.zip",
          targetAppVersion: "1.0.0",
          fingerprintHash: null,
        },
        {
          id: "00000000-0000-0000-0000-000000000021",
          platform: "android",
          shouldForceUpdate: false,
          enabled: true,
          fileHash: "hash2",
          gitCommitHash: null,
          message: "Bundle 2",
          channel: "staging",
          storageUri: "s3://test/2.zip",
          targetAppVersion: "1.0.0",
          fingerprintHash: null,
        },
        {
          id: "00000000-0000-0000-0000-000000000022",
          platform: "ios",
          shouldForceUpdate: false,
          enabled: true,
          fileHash: "hash3",
          gitCommitHash: null,
          message: "Bundle 3",
          channel: "production",
          storageUri: "s3://test/3.zip",
          targetAppVersion: "1.0.0",
          fingerprintHash: null,
        },
      ];

      for (const bundle of bundles) {
        await hotUpdater.insertBundle(bundle);
      }

      // This should not throw a Prisma validation error
      const channels = await hotUpdater.getChannels();

      expect(channels).toHaveLength(2);
      expect(channels).toContain("production");
      expect(channels).toContain("staging");
    });

    it("should return empty array when no bundles exist", async () => {
      const channels = await hotUpdater.getChannels();
      expect(channels).toEqual([]);
    });
  });

  describe("getAppUpdateInfo with storage plugins", () => {
    beforeEach(() => {
      // Fix time for deterministic signed URLs
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2025-10-15T12:21:00Z"));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("resolves s3:// storage URI to signed URL via s3StoragePlugin", async () => {
      const bundle: Bundle = {
        id: "00000000-0000-0000-0000-000000000001",
        platform: "ios",
        shouldForceUpdate: false,
        enabled: true,
        fileHash: "hash123",
        gitCommitHash: null,
        message: "Test bundle",
        channel: "production",
        storageUri: "s3://test-bucket/bundles/bundle.zip",
        targetAppVersion: "1.0.0",
        fingerprintHash: null,
      };

      await hotUpdater.insertBundle(bundle);

      const updateInfo = await hotUpdater.getAppUpdateInfo({
        appVersion: "1.0.0",
        bundleId: NIL_UUID,
        platform: "ios",
        _updateStrategy: "appVersion",
      });

      expect(updateInfo).not.toBeNull();
      expect(updateInfo?.fileUrl).toBe(
        "https://s3.example.com/test-bucket/bundles/bundle.zip",
      );
    });

    it("passes through http:// URLs without plugin resolution", async () => {
      const bundle: Bundle = {
        id: "00000000-0000-0000-0000-000000000004",
        platform: "ios",
        shouldForceUpdate: false,
        enabled: true,
        fileHash: "hashhttp",
        gitCommitHash: null,
        message: "HTTP bundle",
        channel: "production",
        storageUri: "s3://bundle/bundle.zip",
        targetAppVersion: "1.0.0",
        fingerprintHash: null,
      };

      await hotUpdater.insertBundle(bundle);

      const updateInfo = await hotUpdater.getAppUpdateInfo({
        appVersion: "1.0.0",
        bundleId: NIL_UUID,
        platform: "ios",
        _updateStrategy: "appVersion",
      });

      expect(updateInfo).not.toBeNull();
      expect(updateInfo?.fileUrl).toBe(
        "https://s3.example.com/bundle/bundle.zip",
      );
    });

    it("passes through https:// URLs without plugin resolution", async () => {
      const bundle: Bundle = {
        id: "00000000-0000-0000-0000-000000000005",
        platform: "ios",
        shouldForceUpdate: false,
        enabled: true,
        fileHash: "hashhttps",
        gitCommitHash: null,
        message: "HTTPS bundle",
        channel: "production",
        storageUri: "https://cdn.example.com/bundle.zip",
        targetAppVersion: "1.0.0",
        fingerprintHash: null,
      };

      await hotUpdater.insertBundle(bundle);

      const updateInfo = await hotUpdater.getAppUpdateInfo({
        appVersion: "1.0.0",
        bundleId: NIL_UUID,
        platform: "ios",
        _updateStrategy: "appVersion",
      });

      expect(updateInfo).not.toBeNull();
      expect(updateInfo?.fileUrl).toBe("https://cdn.example.com/bundle.zip");
    });

    it("returns null when no update is available", async () => {
      const updateInfo = await hotUpdater.getAppUpdateInfo({
        appVersion: "99.0.0",
        bundleId: NIL_UUID,
        platform: "ios",
        _updateStrategy: "appVersion",
      });

      expect(updateInfo).toBeNull();
    });

    it("works with fingerprint strategy", async () => {
      const bundle: Bundle = {
        id: "00000000-0000-0000-0000-000000000008",
        platform: "ios",
        shouldForceUpdate: false,
        enabled: true,
        fileHash: "hashfp",
        gitCommitHash: null,
        message: "Fingerprint bundle",
        channel: "production",
        storageUri: "s3://test-bucket/fp-bundle.zip",
        targetAppVersion: null,
        fingerprintHash: "fingerprint123",
      };

      await hotUpdater.insertBundle(bundle);

      const updateInfo = await hotUpdater.getAppUpdateInfo({
        fingerprintHash: "fingerprint123",
        bundleId: NIL_UUID,
        platform: "ios",
        _updateStrategy: "fingerprint",
      });

      expect(updateInfo).not.toBeNull();
      expect(updateInfo?.fileUrl).toBe(
        "https://s3.example.com/test-bucket/fp-bundle.zip",
      );
    });

    it("returns manifest metadata and hbc patch descriptors for createHotUpdater", async () => {
      const currentBundle: Bundle = {
        id: "00000000-0000-0000-0000-000000000101",
        platform: "ios",
        shouldForceUpdate: false,
        enabled: true,
        fileHash: "hash-current-zip",
        gitCommitHash: null,
        message: "Current bundle",
        channel: "production",
        storageUri:
          "s3://test-bucket/releases/00000000-0000-0000-0000-000000000101/bundle.zip",
        targetAppVersion: "1.0.0",
        fingerprintHash: null,
        metadata: {
          asset_base_storage_uri:
            "s3://test-bucket/releases/00000000-0000-0000-0000-000000000101/files",
          manifest_file_hash: "sig:manifest-current",
          manifest_storage_uri:
            "s3://test-bucket/releases/00000000-0000-0000-0000-000000000101/manifest.json",
        },
      };
      const nextBundle: Bundle = {
        id: "00000000-0000-0000-0000-000000000102",
        platform: "ios",
        shouldForceUpdate: false,
        enabled: true,
        fileHash: "hash-next-zip",
        gitCommitHash: null,
        message: "Next bundle",
        channel: "production",
        storageUri:
          "s3://test-bucket/releases/00000000-0000-0000-0000-000000000102/bundle.zip",
        targetAppVersion: "1.0.0",
        fingerprintHash: null,
        metadata: {
          asset_base_storage_uri:
            "s3://test-bucket/releases/00000000-0000-0000-0000-000000000102/files",
          patch_base_bundle_id: currentBundle.id,
          hbc_patch_base_file_hash: "hash-old-bundle",
          hbc_patch_file_hash: "hash-bsdiff",
          hbc_patch_storage_uri:
            "s3://test-bucket/releases/00000000-0000-0000-0000-000000000102/patches/00000000-0000-0000-0000-000000000101/index.ios.bundle.bsdiff",
          manifest_file_hash: "sig:manifest-next",
          manifest_storage_uri:
            "s3://test-bucket/releases/00000000-0000-0000-0000-000000000102/manifest.json",
        },
      };
      const fetchMock = vi.fn<typeof fetch>(async (input) => {
        const url = String(input);

        if (url.endsWith(`${currentBundle.id}/manifest.json`)) {
          return new Response(
            JSON.stringify({
              assets: {
                "assets/logo.png": {
                  fileHash: "hash-logo",
                },
                "index.ios.bundle": {
                  fileHash: "hash-old-bundle",
                },
              },
              bundleId: currentBundle.id,
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }

        if (url.endsWith(`${nextBundle.id}/manifest.json`)) {
          return new Response(
            JSON.stringify({
              assets: {
                "assets/logo.png": {
                  fileHash: "hash-logo",
                },
                "index.ios.bundle": {
                  fileHash: "hash-new-bundle",
                },
              },
              bundleId: nextBundle.id,
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }

        return new Response("not found", { status: 404 });
      });

      await hotUpdater.insertBundle(currentBundle);
      await hotUpdater.insertBundle(nextBundle);
      vi.stubGlobal("fetch", fetchMock);

      try {
        await expect(
          hotUpdater.getAppUpdateInfo({
            appVersion: "1.0.0",
            bundleId: currentBundle.id,
            channel: "production",
            platform: "ios",
            _updateStrategy: "appVersion",
          }),
        ).resolves.toEqual({
          changedAssets: {
            "index.ios.bundle": {
              fileHash: "hash-new-bundle",
              patch: {
                algorithm: "bsdiff",
                baseBundleId: currentBundle.id,
                baseFileHash: "hash-old-bundle",
                patchFileHash: "hash-bsdiff",
                patchUrl:
                  "https://s3.example.com/test-bucket/releases/00000000-0000-0000-0000-000000000102/patches/00000000-0000-0000-0000-000000000101/index.ios.bundle.bsdiff",
              },
              fileUrl:
                "https://s3.example.com/test-bucket/releases/00000000-0000-0000-0000-000000000102/files/index.ios.bundle",
            },
          },
          fileHash: "hash-next-zip",
          fileUrl:
            "https://s3.example.com/test-bucket/releases/00000000-0000-0000-0000-000000000102/bundle.zip",
          id: nextBundle.id,
          manifestFileHash: "sig:manifest-next",
          manifestUrl:
            "https://s3.example.com/test-bucket/releases/00000000-0000-0000-0000-000000000102/manifest.json",
          message: "Next bundle",
          shouldForceUpdate: false,
          status: "UPDATE",
        });
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });

  describe("database plugin factories", () => {
    it("isolates pending mutation state between overlapping writes", async () => {
      const committedBundleIds: string[][] = [];
      const onUnmount = vi.fn(async () => undefined);
      let releaseFirstCommit!: () => void;
      let notifyFirstCommitStarted!: () => void;
      const firstCommitStarted = new Promise<void>((resolve) => {
        notifyFirstCommitStarted = resolve;
      });
      const firstCommitGate = new Promise<void>((resolve) => {
        releaseFirstCommit = resolve;
      });
      let commitCount = 0;

      const isolatedHotUpdater = createHotUpdater({
        database: createDatabasePlugin({
          name: "isolatedPlugin",
          factory: () => ({
            async getBundleById() {
              return null;
            },
            async getBundles() {
              return {
                data: [],
                pagination: {
                  hasNextPage: false,
                  hasPreviousPage: false,
                  currentPage: 1,
                  totalPages: 1,
                  total: 0,
                },
              };
            },
            async getChannels() {
              return [];
            },
            onUnmount,
            async commitBundle({ changedSets }) {
              commitCount += 1;
              committedBundleIds.push(
                changedSets.map((change) => change.data.id),
              );

              if (commitCount === 1) {
                notifyFirstCommitStarted();
                await firstCommitGate;
              }
            },
          }),
        })({}),
      });

      const firstBundleId = "00000000-0000-0000-0000-000000000030";
      const secondBundleId = "00000000-0000-0000-0000-000000000031";

      const firstInsert = isolatedHotUpdater.insertBundle({
        id: firstBundleId,
        platform: "ios",
        shouldForceUpdate: false,
        enabled: true,
        fileHash: "hash-1",
        gitCommitHash: null,
        message: "first bundle",
        channel: "production",
        storageUri: "s3://test-bucket/first.zip",
        targetAppVersion: "1.0.0",
        fingerprintHash: null,
      });
      await firstCommitStarted;

      const secondInsert = isolatedHotUpdater.insertBundle({
        id: secondBundleId,
        platform: "ios",
        shouldForceUpdate: false,
        enabled: true,
        fileHash: "hash-2",
        gitCommitHash: null,
        message: "second bundle",
        channel: "production",
        storageUri: "s3://test-bucket/second.zip",
        targetAppVersion: "1.0.0",
        fingerprintHash: null,
      });

      releaseFirstCommit();
      await Promise.all([firstInsert, secondInsert]);

      expect(committedBundleIds).toEqual([[firstBundleId], [secondBundleId]]);
    });
  });
});
