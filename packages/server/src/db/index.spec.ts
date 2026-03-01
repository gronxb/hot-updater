import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { s3Storage } from "@hot-updater/aws";
import { r2Storage } from "@hot-updater/cloudflare";
import type { Bundle, GetBundlesArgs, UpdateInfo } from "@hot-updater/core";
import { NIL_UUID } from "@hot-updater/core";
import { firebaseStorage } from "@hot-updater/firebase";
import type { StoragePlugin } from "@hot-updater/plugin-core";
import { supabaseStorage } from "@hot-updater/supabase";
import { setupGetUpdateInfoTestSuite } from "@hot-updater/test-utils";
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

describe("server/db hotUpdater getUpdateInfo (PGlite + Kysely)", async () => {
  const db = new PGlite();

  const kysely = new Kysely({ dialect: new PGliteDialect(db) });

  const hotUpdater = createHotUpdater({
    database: kyselyAdapter({
      db: kysely,
      provider: "postgresql",
    }),
    storages: [
      s3Storage({
        region: "us-east-1",
        credentials: {
          accessKeyId: "test-access-key",
          secretAccessKey: "test-secret-key",
        },
        bucketName: "test-bucket",
      }),
      r2Storage({
        cloudflareApiToken: "test-token",
        accountId: "test-account-id",
        bucketName: "test-bucket",
      }),
      supabaseStorage({
        supabaseUrl: "https://test.supabase.co",
        supabaseAnonKey: "test-anon-key",
        bucketName: "test-bucket",
      }),
      firebaseStorage({
        storageBucket: "test-bucket.appspot.com",
      }),
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
        "https://test-bucket.s3.us-east-1.amazonaws.com/bundles/bundle.zip?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Content-Sha256=UNSIGNED-PAYLOAD&X-Amz-Credential=test-access-key%2F20251015%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20251015T122100Z&X-Amz-Expires=3600&X-Amz-Signature=4fa782e86a842ce2eacbfa6534d1f5d5145d733092959cf6ad755cc306bbe98e&X-Amz-SignedHeaders=host&x-amz-checksum-mode=ENABLED&x-id=GetObject",
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
        "https://bundle.s3.us-east-1.amazonaws.com/bundle.zip?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Content-Sha256=UNSIGNED-PAYLOAD&X-Amz-Credential=test-access-key%2F20251015%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20251015T122100Z&X-Amz-Expires=3600&X-Amz-Signature=b83d9cfc9bd23275e5eb3baf792776fd7b49730f3aa2f5172d067c9dfb10cd94&X-Amz-SignedHeaders=host&x-amz-checksum-mode=ENABLED&x-id=GetObject",
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
        "https://test-bucket.s3.us-east-1.amazonaws.com/fp-bundle.zip?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Content-Sha256=UNSIGNED-PAYLOAD&X-Amz-Credential=test-access-key%2F20251015%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20251015T122100Z&X-Amz-Expires=3600&X-Amz-Signature=d70e9b699dccbb51cf32f3e5b7912f2567d38f7e508b1f30091a8fee0d0abb65&X-Amz-SignedHeaders=host&x-amz-checksum-mode=ENABLED&x-id=GetObject",
      );
    });
  });

  describe("getAppUpdateInfo incremental (bsdiff-v1)", () => {
    const fixtureRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../..",
      "bsdiff",
      "fixture",
    );

    const fixtureOnePath = path.join(
      fixtureRoot,
      "one",
      "index.ios.bundle.hbc",
    );
    const fixtureTwoPath = path.join(
      fixtureRoot,
      "two",
      "index.ios.bundle.hbc",
    );

    const sha256 = (input: Uint8Array): string => {
      return createHash("sha256").update(input).digest("hex");
    };

    const createMemoryHotUpdater = () => {
      const objects = new Map<string, Uint8Array>();
      let patchUploadCount = 0;

      const memoryStorage: StoragePlugin = {
        supportedProtocol: "memory",
        name: "memoryStorage",
        async upload(key, filePath) {
          const file = await fs.readFile(filePath);
          const filename = path.basename(filePath);
          const fullKey = [key, filename].filter(Boolean).join("/");
          objects.set(fullKey, new Uint8Array(file));
          if (fullKey.includes("/.patches/")) {
            patchUploadCount += 1;
          }
          return { storageUri: `memory://bucket/${fullKey}` };
        },
        async delete(storageUri) {
          const key = storageUri.replace("memory://bucket/", "");
          objects.delete(key);
        },
        async getDownloadUrl(storageUri) {
          const key = storageUri.replace("memory://bucket/", "");
          const bytes = objects.get(key);
          if (!bytes) {
            throw new Error(`Object not found: ${key}`);
          }
          const base64 = Buffer.from(bytes).toString("base64");
          return {
            fileUrl: `data:application/octet-stream;base64,${base64}`,
          };
        },
      };

      return {
        objects,
        getPatchUploadCount: () => patchUploadCount,
        hotUpdater: createHotUpdater({
          database: kyselyAdapter({
            db: kysely,
            provider: "postgresql",
          }),
          storages: [memoryStorage],
        }),
      };
    };

    it("returns incremental plan, computes changed assets, and reuses patch cache", async () => {
      const {
        hotUpdater: incrementalHotUpdater,
        objects,
        getPatchUploadCount,
      } = createMemoryHotUpdater();

      const [baseBundleBytes, targetBundleBytes] = await Promise.all([
        fs.readFile(fixtureOnePath),
        fs.readFile(fixtureTwoPath),
      ]);

      const unchangedAsset = Buffer.from("same-asset-bytes");
      const changedAsset = Buffer.from("changed-asset-bytes-v2");

      const baseBundleId = "00000000-0000-0000-0000-000000000100";
      const targetBundleId = "00000000-0000-0000-0000-000000000101";

      const putObject = (key: string, bytes: Uint8Array): string => {
        objects.set(key, bytes);
        return `memory://bucket/${key}`;
      };

      const baseBundleHash = sha256(baseBundleBytes);
      const targetBundleHash = sha256(targetBundleBytes);
      const unchangedAssetHash = sha256(unchangedAsset);
      const changedAssetHash = sha256(changedAsset);

      putObject(`${baseBundleId}/index.ios.bundle`, baseBundleBytes);
      putObject(`${baseBundleId}/assets/common.txt`, unchangedAsset);
      putObject(`${targetBundleId}/index.ios.bundle`, targetBundleBytes);
      putObject(`${targetBundleId}/assets/common.txt`, unchangedAsset);
      putObject(`${targetBundleId}/assets/changed.txt`, changedAsset);

      const baseManifest = [
        {
          path: "index.ios.bundle",
          hash: baseBundleHash,
          size: baseBundleBytes.length,
          kind: "bundle" as const,
        },
        {
          path: "assets/common.txt",
          hash: unchangedAssetHash,
          size: unchangedAsset.length,
          kind: "asset" as const,
        },
      ];

      const targetManifest = [
        {
          path: "index.ios.bundle",
          hash: targetBundleHash,
          size: targetBundleBytes.length,
          kind: "bundle" as const,
        },
        {
          path: "assets/common.txt",
          hash: unchangedAssetHash,
          size: unchangedAsset.length,
          kind: "asset" as const,
        },
        {
          path: "assets/changed.txt",
          hash: changedAssetHash,
          size: changedAsset.length,
          kind: "asset" as const,
        },
      ];

      await incrementalHotUpdater.insertBundle({
        id: baseBundleId,
        platform: "ios",
        shouldForceUpdate: false,
        enabled: true,
        fileHash: baseBundleHash,
        gitCommitHash: null,
        message: "base",
        channel: "production",
        storageUri: `memory://bucket/${baseBundleId}/index.ios.bundle`,
        targetAppVersion: "1.0.0",
        fingerprintHash: null,
        metadata: {
          incremental: {
            bundleHash: baseBundleHash,
            manifest: baseManifest,
            patchCache: {},
          },
        },
      });

      await incrementalHotUpdater.insertBundle({
        id: targetBundleId,
        platform: "ios",
        shouldForceUpdate: false,
        enabled: true,
        fileHash: targetBundleHash,
        gitCommitHash: null,
        message: "target",
        channel: "production",
        storageUri: `memory://bucket/${targetBundleId}/index.ios.bundle`,
        targetAppVersion: "1.0.0",
        fingerprintHash: null,
        metadata: {
          incremental: {
            bundleHash: targetBundleHash,
            manifest: targetManifest,
            patchCache: {},
          },
        },
      });

      const update = await incrementalHotUpdater.getAppUpdateInfo({
        _updateStrategy: "appVersion",
        appVersion: "1.0.0",
        platform: "ios",
        bundleId: baseBundleId,
        minBundleId: NIL_UUID,
        channel: "production",
        currentHash: baseBundleHash,
      });

      expect(update).not.toBeNull();
      expect(update?.incremental?.protocol).toBe("bsdiff-v1");
      expect(update?.incremental?.baseBundleId).toBe(baseBundleId);
      expect(update?.incremental?.baseBundleHash).toBe(baseBundleHash);
      expect(update?.incremental?.bundlePath).toBe("index.ios.bundle");
      expect(update?.incremental?.patch.fileHash).toMatch(/^[a-f0-9]{64}$/);
      expect(update?.incremental?.changedAssets).toEqual([
        expect.objectContaining({
          path: "assets/changed.txt",
          hash: changedAssetHash,
          size: changedAsset.length,
        }),
      ]);
      expect(getPatchUploadCount()).toBe(1);

      const updateSecond = await incrementalHotUpdater.getAppUpdateInfo({
        _updateStrategy: "appVersion",
        appVersion: "1.0.0",
        platform: "ios",
        bundleId: baseBundleId,
        minBundleId: NIL_UUID,
        channel: "production",
        currentHash: baseBundleHash,
      });

      expect(updateSecond?.incremental?.patch.fileHash).toBe(
        update?.incremental?.patch.fileHash,
      );
      expect(getPatchUploadCount()).toBe(1);

      const mismatchHashResult = await incrementalHotUpdater.getAppUpdateInfo({
        _updateStrategy: "appVersion",
        appVersion: "1.0.0",
        platform: "ios",
        bundleId: baseBundleId,
        minBundleId: NIL_UUID,
        channel: "production",
        currentHash: "deadbeef",
      });

      expect(mismatchHashResult).toBeNull();

      const emptyHashResult = await incrementalHotUpdater.getAppUpdateInfo({
        _updateStrategy: "appVersion",
        appVersion: "1.0.0",
        platform: "ios",
        bundleId: baseBundleId,
        minBundleId: NIL_UUID,
        channel: "production",
        currentHash: "",
      });

      expect(emptyHashResult).toBeNull();
    });

    it("returns legacy response when currentHash is omitted", async () => {
      const { hotUpdater: incrementalHotUpdater, objects } =
        createMemoryHotUpdater();

      const targetBundleId = "00000000-0000-0000-0000-000000000202";
      const targetBytes = await fs.readFile(fixtureTwoPath);
      const targetHash = sha256(targetBytes);

      objects.set(
        `${targetBundleId}/index.ios.bundle`,
        new Uint8Array(targetBytes),
      );

      await incrementalHotUpdater.insertBundle({
        id: targetBundleId,
        platform: "ios",
        shouldForceUpdate: false,
        enabled: true,
        fileHash: targetHash,
        gitCommitHash: null,
        message: "legacy",
        channel: "production",
        storageUri: `memory://bucket/${targetBundleId}/index.ios.bundle`,
        targetAppVersion: "1.0.0",
        fingerprintHash: null,
      });

      const update = await incrementalHotUpdater.getAppUpdateInfo({
        _updateStrategy: "appVersion",
        appVersion: "1.0.0",
        platform: "ios",
        bundleId: NIL_UUID,
        minBundleId: NIL_UUID,
        channel: "production",
      });

      expect(update).not.toBeNull();
      expect(update?.incremental).toBeUndefined();
      expect(update?.fileHash).toBe(targetHash);
      expect(update?.fileUrl).toContain(
        "data:application/octet-stream;base64,",
      );
    });

    it("returns null when metadata.bundleHash mismatches manifest bundle hash", async () => {
      const {
        hotUpdater: incrementalHotUpdater,
        objects,
        getPatchUploadCount,
      } = createMemoryHotUpdater();

      const [baseBundleBytes, targetBundleBytes] = await Promise.all([
        fs.readFile(fixtureOnePath),
        fs.readFile(fixtureTwoPath),
      ]);

      const baseBundleId = "00000000-0000-0000-0000-000000000300";
      const targetBundleId = "00000000-0000-0000-0000-000000000301";
      const baseBundleHash = sha256(baseBundleBytes);
      const targetBundleHash = sha256(targetBundleBytes);

      objects.set(
        `${baseBundleId}/index.ios.bundle`,
        new Uint8Array(baseBundleBytes),
      );
      objects.set(
        `${targetBundleId}/index.ios.bundle`,
        new Uint8Array(targetBundleBytes),
      );

      await incrementalHotUpdater.insertBundle({
        id: baseBundleId,
        platform: "ios",
        shouldForceUpdate: false,
        enabled: true,
        fileHash: baseBundleHash,
        gitCommitHash: null,
        message: "base",
        channel: "production",
        storageUri: `memory://bucket/${baseBundleId}/index.ios.bundle`,
        targetAppVersion: "1.0.0",
        fingerprintHash: null,
        metadata: {
          incremental: {
            bundleHash: baseBundleHash,
            manifest: [
              {
                path: "index.ios.bundle",
                hash: baseBundleHash,
                size: baseBundleBytes.length,
                kind: "bundle",
              },
            ],
            patchCache: {},
          },
        },
      });

      await incrementalHotUpdater.insertBundle({
        id: targetBundleId,
        platform: "ios",
        shouldForceUpdate: false,
        enabled: true,
        fileHash: targetBundleHash,
        gitCommitHash: null,
        message: "target",
        channel: "production",
        storageUri: `memory://bucket/${targetBundleId}/index.ios.bundle`,
        targetAppVersion: "1.0.0",
        fingerprintHash: null,
        metadata: {
          incremental: {
            bundleHash: "deadbeef",
            manifest: [
              {
                path: "index.ios.bundle",
                hash: targetBundleHash,
                size: targetBundleBytes.length,
                kind: "bundle",
              },
            ],
            patchCache: {},
          },
        },
      });

      const update = await incrementalHotUpdater.getAppUpdateInfo({
        _updateStrategy: "appVersion",
        appVersion: "1.0.0",
        platform: "ios",
        bundleId: baseBundleId,
        minBundleId: NIL_UUID,
        channel: "production",
        currentHash: baseBundleHash,
      });

      expect(update).toBeNull();
      expect(getPatchUploadCount()).toBe(0);
    });

    it("returns null for non-Hermes bundle bytes when currentHash is provided", async () => {
      const {
        hotUpdater: incrementalHotUpdater,
        objects,
        getPatchUploadCount,
      } = createMemoryHotUpdater();

      const baseBundleId = "00000000-0000-0000-0000-000000000400";
      const targetBundleId = "00000000-0000-0000-0000-000000000401";
      const baseBytes = Buffer.from("plain-js-bundle-base");
      const targetBytes = Buffer.from("plain-js-bundle-target");
      const baseHash = sha256(baseBytes);
      const targetHash = sha256(targetBytes);

      objects.set(`${baseBundleId}/index.ios.bundle`, baseBytes);
      objects.set(`${targetBundleId}/index.ios.bundle`, targetBytes);

      await incrementalHotUpdater.insertBundle({
        id: baseBundleId,
        platform: "ios",
        shouldForceUpdate: false,
        enabled: true,
        fileHash: baseHash,
        gitCommitHash: null,
        message: "base",
        channel: "production",
        storageUri: `memory://bucket/${baseBundleId}/index.ios.bundle`,
        targetAppVersion: "1.0.0",
        fingerprintHash: null,
        metadata: {
          incremental: {
            bundleHash: baseHash,
            manifest: [
              {
                path: "index.ios.bundle",
                hash: baseHash,
                size: baseBytes.length,
                kind: "bundle",
              },
            ],
            patchCache: {},
          },
        },
      });

      await incrementalHotUpdater.insertBundle({
        id: targetBundleId,
        platform: "ios",
        shouldForceUpdate: false,
        enabled: true,
        fileHash: targetHash,
        gitCommitHash: null,
        message: "target",
        channel: "production",
        storageUri: `memory://bucket/${targetBundleId}/index.ios.bundle`,
        targetAppVersion: "1.0.0",
        fingerprintHash: null,
        metadata: {
          incremental: {
            bundleHash: targetHash,
            manifest: [
              {
                path: "index.ios.bundle",
                hash: targetHash,
                size: targetBytes.length,
                kind: "bundle",
              },
            ],
            patchCache: {},
          },
        },
      });

      const update = await incrementalHotUpdater.getAppUpdateInfo({
        _updateStrategy: "appVersion",
        appVersion: "1.0.0",
        platform: "ios",
        bundleId: baseBundleId,
        minBundleId: NIL_UUID,
        channel: "production",
        currentHash: baseHash,
      });

      expect(update).toBeNull();
      expect(getPatchUploadCount()).toBe(0);
    });
  });
});
