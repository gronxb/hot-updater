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
    storagePlugins: [
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
});
