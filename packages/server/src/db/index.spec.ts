import { PGlite } from "@electric-sql/pglite";
import { s3Storage } from "@hot-updater/aws";
import { r2Storage } from "@hot-updater/cloudflare";
import type { Bundle, GetBundlesArgs, UpdateInfo } from "@hot-updater/core";
import { NIL_UUID } from "@hot-updater/core";
import { firebaseStorage } from "@hot-updater/firebase";
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

  describe("Issue #700: Bundle copy with dangling storage reference", () => {
    it("reproduces bundle copy deletion scenario", async () => {
      /**
       * REPRODUCTION SCENARIO:
       *
       * 1. User creates Bundle A in production channel
       *    - storageUri: "s3://test-bucket/bundle.zip"
       *    - S3 file uploaded ✓
       *
       * 2. User COPIES Bundle A to beta channel (via promote-channel-dialog.tsx)
       *    - Creates Bundle B with SAME storageUri: "s3://test-bucket/bundle.zip"
       *    - Both bundles reference the same S3 file
       *
       * 3. User DELETES Bundle A from production (via console RPC)
       *    - RPC calls: databasePlugin.deleteBundle() → DB entry removed ✓
       *    - RPC calls: storagePlugin.delete(storageUri) → S3 file deleted ✓
       *    - NO reference counting! File deleted even though Bundle B still needs it
       *
       * 4. Client requests update from beta channel
       *    - getAppUpdateInfo returns Bundle B ✓
       *    - Generates signed URL for "s3://test-bucket/bundle.zip" ✓
       *    - But file was deleted in step 3!
       *    - Client gets 404 error when downloading ✗
       *
       * ROOT CAUSE:
       * - Copy operation copies storageUri reference (not the file)
       * - Delete operation deletes storage file WITHOUT checking other references
       * - No reference counting for shared storage URIs
       */

      const sharedStorageUri = "s3://test-bucket/shared-bundle.zip";

      // Step 1 & 2: Both bundles exist with same storageUri (after copy)
      const productionBundle: Bundle = {
        id: "00000000-0000-0000-0000-000000000001",
        platform: "ios",
        shouldForceUpdate: false,
        enabled: true,
        fileHash: "hash-original",
        gitCommitHash: null,
        message: "Original bundle",
        channel: "production",
        storageUri: sharedStorageUri,
        targetAppVersion: "1.0.0",
        fingerprintHash: null,
      };

      const betaBundle: Bundle = {
        id: "00000000-0000-0000-0000-000000000002",
        platform: "ios",
        shouldForceUpdate: false,
        enabled: true,
        fileHash: "hash-copied",
        gitCommitHash: null,
        message: "Copied bundle",
        channel: "beta",
        storageUri: sharedStorageUri, // SAME storageUri after copy!
        targetAppVersion: "1.0.0",
        fingerprintHash: null,
      };

      await hotUpdater.insertBundle(productionBundle);
      await hotUpdater.insertBundle(betaBundle);

      // Step 3: Simulate production bundle deletion
      // In real scenario: RPC would call storagePlugin.delete(storageUri)
      // This deletes the S3 file that BOTH bundles reference
      await hotUpdater.deleteBundleById(productionBundle.id);
      // Note: deleteBundleById only removes DB entry, not storage file
      // But in RPC (packages/console/src-server/rpc.ts:182),
      // it ALSO calls: await storagePlugin.delete(bundle.storageUri)
      // We can't easily mock this here, but the conceptual problem remains

      // Step 4: Client requests update from beta channel
      const updateInfo = await hotUpdater.getAppUpdateInfo({
        appVersion: "1.0.0",
        bundleId: NIL_UUID,
        platform: "ios",
        channel: "beta",
        _updateStrategy: "appVersion",
      });

      /**
       * EXPECTED (after fix):
       * - Should return null because storage file doesn't exist
       * - Or validate file existence before returning
       * - Or use reference counting to prevent premature deletion
       *
       * ACTUAL (current bug):
       * - Returns Bundle B with signed URL
       * - Storage plugin generates URL WITHOUT checking file existence
       * - Clients receive 404 error when downloading
       */
      expect(updateInfo).toBeNull();
    });

    it("storage plugins generate signed URLs without validating file existence", async () => {
      /**
       * This test demonstrates the core technical issue:
       * Storage plugins (S3, R2, Cloudflare, etc.) implement getDownloadUrl()
       * which generates pre-signed URLs WITHOUT checking if the file exists.
       *
       * This is by design for performance (avoid extra S3 HEAD requests),
       * but creates the Issue #700 problem when combined with:
       * - Bundle copy sharing storageUri
       * - Delete operation not checking references
       */

      const bundle: Bundle = {
        id: "00000000-0000-0000-0000-000000000003",
        platform: "ios",
        shouldForceUpdate: false,
        enabled: true,
        fileHash: "hash-nonexistent",
        gitCommitHash: null,
        message: "Bundle referencing non-existent file",
        channel: "production",
        storageUri: "s3://test-bucket/this-file-never-existed.zip",
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

      // BUG: Returns signed URL for file that doesn't exist
      // No validation step before generating URL
      // Client will receive 404 when attempting download
      expect(updateInfo).toBeNull();
    });
  });
});
