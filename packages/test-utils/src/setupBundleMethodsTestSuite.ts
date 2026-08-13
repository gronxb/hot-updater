import type { Bundle, LegacyBundle, Platform } from "@hot-updater/core";
import type { ChannelRow } from "@hot-updater/plugin-core";
import { beforeEach, describe, expect, it } from "vitest";

interface PaginationInfo {
  readonly total: number;
  readonly hasNextPage: boolean;
  readonly hasPreviousPage: boolean;
  readonly currentPage: number;
  readonly totalPages: number;
  readonly nextCursor?: string | null;
}

interface ArtifactQueryOptions {
  readonly where?: {
    readonly platform?: Platform;
    readonly id?: {
      readonly eq?: string;
      readonly in?: string[];
    };
  };
  readonly limit: number;
  readonly cursor?: { readonly after: string };
  readonly orderBy?: {
    readonly field: "id";
    readonly direction: "asc" | "desc";
  };
}

const legacyBundle = (
  id: string,
  overrides: Partial<LegacyBundle> = {},
): LegacyBundle => ({
  id,
  platform: "ios",
  fileHash: `hash-${id}`,
  gitCommitHash: null,
  storageUri: `mock://artifacts/${id}.zip`,
  channel: "production",
  enabled: true,
  fingerprintHash: null,
  message: `Release for ${id}`,
  shouldForceUpdate: false,
  targetAppVersion: "1.0.0",
  rolloutCohortCount: 1_000,
  targetCohorts: [],
  ...overrides,
});

export const setupBundleMethodsTestSuite = ({
  getBundleById,
  getChannels,
  insertBundle,
  getBundles,
  deleteBundleById,
}: {
  readonly getBundleById: (id: string) => Promise<Bundle | null>;
  readonly getChannels: () => Promise<readonly ChannelRow[]>;
  readonly insertBundle: (bundle: LegacyBundle) => Promise<void>;
  readonly getBundles: (options: ArtifactQueryOptions) => Promise<{
    readonly data: Bundle[];
    readonly pagination: PaginationInfo;
  }>;
  readonly updateBundleById?: (
    bundleId: string,
    newBundle: Partial<Bundle>,
  ) => Promise<void>;
  readonly deleteBundleById: (bundleId: string) => Promise<void>;
}) => {
  beforeEach(async () => {
    for (;;) {
      const existing = await getBundles({ limit: 1_000 });
      if (existing.data.length === 0) return;
      for (const artifact of existing.data) {
        await deleteBundleById(artifact.id);
      }
    }
  });

  describe("Bundle artifact repository", () => {
    it("persists artifact fields while keeping delivery policy off Bundle reads", async () => {
      const input = legacyBundle("00000000-0000-0000-0000-000000000010", {
        rolloutCohortCount: 250,
        targetCohorts: ["qa"],
      });

      await insertBundle(input);

      const artifact = await getBundleById(input.id);
      expect(artifact).toMatchObject({
        id: input.id,
        platform: "ios",
        fileHash: input.fileHash,
        storageUri: input.storageUri,
      });
      expect(artifact).not.toHaveProperty("channel");
      expect(artifact).not.toHaveProperty("enabled");
      expect(artifact).not.toHaveProperty("rolloutCohortCount");
      expect(artifact).not.toHaveProperty("targetCohorts");
    });

    it("returns null for a missing artifact", async () => {
      await expect(
        getBundleById("99999999-9999-9999-9999-999999999999"),
      ).resolves.toBeNull();
    });

    it("creates Channels from legacy delivery input", async () => {
      await insertBundle(legacyBundle("00000000-0000-0000-0000-000000000020"));
      await insertBundle(
        legacyBundle("00000000-0000-0000-0000-000000000021", {
          channel: "staging",
          platform: "android",
        }),
      );

      const names = (await getChannels()).map(({ name }) => name);
      expect(names).toContain("production");
      expect(names).toContain("staging");
    });

    it("filters artifacts by platform and id without Release policy filters", async () => {
      const ios = legacyBundle("00000000-0000-0000-0000-000000000030");
      const android = legacyBundle("00000000-0000-0000-0000-000000000031", {
        platform: "android",
      });
      await insertBundle(ios);
      await insertBundle(android);

      const byPlatform = await getBundles({
        where: { platform: "android" },
        limit: 10,
      });
      const byId = await getBundles({
        where: { id: { in: [ios.id] } },
        limit: 10,
      });

      expect(byPlatform.data.map(({ id }) => id)).toEqual([android.id]);
      expect(byId.data.map(({ id }) => id)).toEqual([ios.id]);
    });

    it("supports stable artifact cursor pagination", async () => {
      const first = legacyBundle("00000000-0000-0000-0000-000000000040");
      const second = legacyBundle("00000000-0000-0000-0000-000000000041");
      await insertBundle(first);
      await insertBundle(second);

      const page1 = await getBundles({
        limit: 1,
        orderBy: { field: "id", direction: "desc" },
      });
      const cursor = page1.pagination.nextCursor;
      if (!cursor) throw new Error("Expected an artifact cursor.");
      const page2 = await getBundles({
        cursor: { after: cursor },
        limit: 1,
        orderBy: { field: "id", direction: "desc" },
      });

      expect(page1.data).toHaveLength(1);
      expect(page2.data).toHaveLength(1);
      expect(page1.data[0]?.id).not.toBe(page2.data[0]?.id);
    });

    it("deletes an artifact after its legacy Release is removed by the API", async () => {
      const input = legacyBundle("00000000-0000-0000-0000-000000000050");
      await insertBundle(input);

      await deleteBundleById(input.id);

      await expect(getBundleById(input.id)).resolves.toBeNull();
    });
  });
};
