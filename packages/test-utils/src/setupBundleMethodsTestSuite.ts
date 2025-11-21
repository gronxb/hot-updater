import type { Bundle } from "@hot-updater/core";
import { describe, expect, it } from "vitest";

interface PaginationInfo {
  total: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  currentPage: number;
  totalPages: number;
}

export const setupBundleMethodsTestSuite = ({
  getBundleById,
  getChannels,
  insertBundle,
  getBundles,
  updateBundleById,
  deleteBundleById,
}: {
  getBundleById: (id: string) => Promise<Bundle | null>;
  getChannels: () => Promise<string[]>;
  insertBundle: (bundle: Bundle) => Promise<void>;
  getBundles: (options: {
    where?: { channel?: string; platform?: string };
    limit: number;
    offset: number;
  }) => Promise<{ data: Bundle[]; pagination: PaginationInfo }>;
  updateBundleById: (
    bundleId: string,
    newBundle: Partial<Bundle>,
  ) => Promise<void>;
  deleteBundleById: (bundleId: string) => Promise<void>;
}) => {
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
        storageUri: "mock://test-bucket/test.zip",
        targetAppVersion: "1.0.0",
        fingerprintHash: null,
      };

      await insertBundle(bundle);

      // This should not throw a Prisma validation error
      const retrieved = await getBundleById(bundle.id);

      expect(retrieved).not.toBeNull();
      expect(retrieved?.id).toBe(bundle.id);
      expect(retrieved?.platform).toBe(bundle.platform);
      expect(retrieved?.fileHash).toBe(bundle.fileHash);
    });

    it("should return null for non-existent bundle id", async () => {
      const retrieved = await getBundleById(
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
          storageUri: "mock://test/1.zip",
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
          storageUri: "mock://test/2.zip",
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
          storageUri: "mock://test/3.zip",
          targetAppVersion: "1.0.0",
          fingerprintHash: null,
        },
      ];

      for (const bundle of bundles) {
        await insertBundle(bundle);
      }

      // This should not throw a Prisma validation error
      const channels = await getChannels();

      expect(channels.length).toBeGreaterThanOrEqual(2);
      expect(channels).toContain("production");
      expect(channels).toContain("staging");
    });
  });

  describe("getBundles", () => {
    it("should retrieve all bundles without filters", async () => {
      const bundles: Bundle[] = [
        {
          id: "00000000-0000-0000-0000-000000000030",
          platform: "ios",
          shouldForceUpdate: false,
          enabled: true,
          fileHash: "hash1",
          gitCommitHash: null,
          message: "Bundle 1",
          channel: "production",
          storageUri: "mock://test/1.zip",
          targetAppVersion: "1.0.0",
          fingerprintHash: null,
        },
        {
          id: "00000000-0000-0000-0000-000000000031",
          platform: "android",
          shouldForceUpdate: false,
          enabled: true,
          fileHash: "hash2",
          gitCommitHash: null,
          message: "Bundle 2",
          channel: "staging",
          storageUri: "mock://test/2.zip",
          targetAppVersion: "1.0.0",
          fingerprintHash: null,
        },
      ];

      for (const bundle of bundles) {
        await insertBundle(bundle);
      }

      const result = await getBundles({
        limit: 10,
        offset: 0,
      });

      expect(result.data.length).toBeGreaterThanOrEqual(2);
      expect(result.pagination).toBeDefined();
      expect(result.pagination.total).toBeGreaterThanOrEqual(2);
      expect(result.pagination.currentPage).toBe(1);
    });

    it("should filter bundles by channel", async () => {
      const bundles: Bundle[] = [
        {
          id: "00000000-0000-0000-0000-000000000032",
          platform: "ios",
          shouldForceUpdate: false,
          enabled: true,
          fileHash: "hash3",
          gitCommitHash: null,
          message: "Production bundle",
          channel: "production",
          storageUri: "mock://test/3.zip",
          targetAppVersion: "1.0.0",
          fingerprintHash: null,
        },
        {
          id: "00000000-0000-0000-0000-000000000033",
          platform: "ios",
          shouldForceUpdate: false,
          enabled: true,
          fileHash: "hash4",
          gitCommitHash: null,
          message: "Beta bundle",
          channel: "beta",
          storageUri: "mock://test/4.zip",
          targetAppVersion: "1.0.0",
          fingerprintHash: null,
        },
      ];

      for (const bundle of bundles) {
        await insertBundle(bundle);
      }

      const result = await getBundles({
        where: { channel: "beta" },
        limit: 10,
        offset: 0,
      });

      expect(result.data.length).toBeGreaterThanOrEqual(1);
      for (const bundle of result.data) {
        expect(bundle.channel).toBe("beta");
      }
    });

    it("should filter bundles by platform", async () => {
      const bundles: Bundle[] = [
        {
          id: "00000000-0000-0000-0000-000000000034",
          platform: "ios",
          shouldForceUpdate: false,
          enabled: true,
          fileHash: "hash5",
          gitCommitHash: null,
          message: "iOS bundle",
          channel: "production",
          storageUri: "mock://test/5.zip",
          targetAppVersion: "1.0.0",
          fingerprintHash: null,
        },
        {
          id: "00000000-0000-0000-0000-000000000035",
          platform: "android",
          shouldForceUpdate: false,
          enabled: true,
          fileHash: "hash6",
          gitCommitHash: null,
          message: "Android bundle",
          channel: "production",
          storageUri: "mock://test/6.zip",
          targetAppVersion: "1.0.0",
          fingerprintHash: null,
        },
      ];

      for (const bundle of bundles) {
        await insertBundle(bundle);
      }

      const result = await getBundles({
        where: { platform: "android" },
        limit: 10,
        offset: 0,
      });

      expect(result.data.length).toBeGreaterThanOrEqual(1);
      for (const bundle of result.data) {
        expect(bundle.platform).toBe("android");
      }
    });

    it("should support pagination", async () => {
      const bundles: Bundle[] = [
        {
          id: "00000000-0000-0000-0000-000000000036",
          platform: "ios",
          shouldForceUpdate: false,
          enabled: true,
          fileHash: "hash7",
          gitCommitHash: null,
          message: "Bundle 1",
          channel: "production",
          storageUri: "mock://test/7.zip",
          targetAppVersion: "1.0.0",
          fingerprintHash: null,
        },
        {
          id: "00000000-0000-0000-0000-000000000037",
          platform: "ios",
          shouldForceUpdate: false,
          enabled: true,
          fileHash: "hash8",
          gitCommitHash: null,
          message: "Bundle 2",
          channel: "production",
          storageUri: "mock://test/8.zip",
          targetAppVersion: "1.0.0",
          fingerprintHash: null,
        },
      ];

      for (const bundle of bundles) {
        await insertBundle(bundle);
      }

      const page1 = await getBundles({
        limit: 1,
        offset: 0,
      });

      const page2 = await getBundles({
        limit: 1,
        offset: 1,
      });

      expect(page1.data.length).toBe(1);
      expect(page2.data.length).toBe(1);
      expect(page1.data[0].id).not.toBe(page2.data[0].id);
    });

    it("should handle concurrent getBundles calls without errors", async () => {
      // Test for fumadb getSchemaVersion bug fix
      // Previously, concurrent calls would cause unique constraint violations
      // because getSchemaVersion() performed delete+create instead of read
      const concurrentCalls = Array(10)
        .fill(null)
        .map(() =>
          getBundles({
            limit: 10,
            offset: 0,
          }),
        );

      // All concurrent calls should succeed without throwing errors
      const results = await Promise.all(concurrentCalls);

      for (const result of results) {
        expect(result.data).toBeDefined();
        expect(result.pagination).toBeDefined();
      }
    });
  });

  describe("updateBundleById", () => {
    it("should update bundle enabled status", async () => {
      const bundle: Bundle = {
        id: "00000000-0000-0000-0000-000000000040",
        platform: "ios",
        shouldForceUpdate: false,
        enabled: true,
        fileHash: "hash-update",
        gitCommitHash: null,
        message: "Original message",
        channel: "production",
        storageUri: "mock://test/update.zip",
        targetAppVersion: "1.0.0",
        fingerprintHash: null,
      };

      await insertBundle(bundle);

      await updateBundleById(bundle.id, { enabled: false });

      const updated = await getBundleById(bundle.id);
      expect(updated).not.toBeNull();
      expect(updated?.enabled).toBe(false);
      expect(updated?.message).toBe("Original message");
    });

    it("should update bundle message", async () => {
      const bundle: Bundle = {
        id: "00000000-0000-0000-0000-000000000041",
        platform: "ios",
        shouldForceUpdate: false,
        enabled: true,
        fileHash: "hash-message",
        gitCommitHash: null,
        message: "Old message",
        channel: "production",
        storageUri: "mock://test/message.zip",
        targetAppVersion: "1.0.0",
        fingerprintHash: null,
      };

      await insertBundle(bundle);

      await updateBundleById(bundle.id, { message: "New message" });

      const updated = await getBundleById(bundle.id);
      expect(updated).not.toBeNull();
      expect(updated?.message).toBe("New message");
      expect(updated?.enabled).toBe(true);
    });

    it("should update multiple fields at once", async () => {
      const bundle: Bundle = {
        id: "00000000-0000-0000-0000-000000000042",
        platform: "ios",
        shouldForceUpdate: false,
        enabled: true,
        fileHash: "hash-multi",
        gitCommitHash: null,
        message: "Original",
        channel: "production",
        storageUri: "mock://test/multi.zip",
        targetAppVersion: "1.0.0",
        fingerprintHash: null,
      };

      await insertBundle(bundle);

      await updateBundleById(bundle.id, {
        enabled: false,
        message: "Updated message",
        shouldForceUpdate: true,
      });

      const updated = await getBundleById(bundle.id);
      expect(updated).not.toBeNull();
      expect(updated?.enabled).toBe(false);
      expect(updated?.message).toBe("Updated message");
      expect(updated?.shouldForceUpdate).toBe(true);
    });
  });

  describe("deleteBundleById", () => {
    it("should delete bundle successfully", async () => {
      const bundle: Bundle = {
        id: "00000000-0000-0000-0000-000000000050",
        platform: "ios",
        shouldForceUpdate: false,
        enabled: true,
        fileHash: "hash-delete",
        gitCommitHash: null,
        message: "To be deleted",
        channel: "production",
        storageUri: "mock://test/delete.zip",
        targetAppVersion: "1.0.0",
        fingerprintHash: null,
      };

      await insertBundle(bundle);

      const before = await getBundleById(bundle.id);
      expect(before).not.toBeNull();

      await deleteBundleById(bundle.id);

      const after = await getBundleById(bundle.id);
      expect(after).toBeNull();
    });

    it("should not throw error when deleting non-existent bundle", async () => {
      await expect(
        deleteBundleById("99999999-9999-9999-9999-999999999998"),
      ).resolves.not.toThrow();
    });
  });
};
