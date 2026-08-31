// @vitest-environment node

import type { Bundle, ReleaseRow } from "@hot-updater/plugin-core";
import { describe, expect, it, vi } from "vitest";

import {
  InsightsBundlePaginationError,
  collectInsightsOverview,
  getInsightsCapabilities,
} from "./insights-rpc";

const createBundle = (id: string): Bundle => ({
  id,
  platform: "ios",
  fileHash: `hash-${id}`,
  storageUri: `storage://${id}.zip`,
  archiveByteSize: 3_000_000_001,
  gitCommitHash: null,
});

const createRelease = (bundleId: string): ReleaseRow => ({
  id: `release-${bundleId}`,
  revision: 1,
  scope_key: "scope-production-ios",
  channel_id: "channel-production",
  platform: "ios",
  kind: "BUNDLE",
  bundle_id: bundleId,
  strategy: "APP_VERSION",
  target_app_version: "1.0.0",
  fingerprint_hash: null,
  enabled: true,
  should_force_update: false,
  message: null,
  rollout_cohort_count: 1000,
  target_cohorts: [],
  operation: "DEPLOY",
  source_release_id: null,
  created_at_ms: 1,
  updated_at_ms: 1,
});

const createReleasePager =
  (releases: readonly ReleaseRow[]) =>
  async ({
    beforeReleaseId,
    limit,
  }: {
    beforeReleaseId?: string;
    limit: number;
  }) => {
    const start = beforeReleaseId
      ? releases.findIndex(({ id }) => id === beforeReleaseId) + 1
      : 0;
    return releases.slice(start, start + limit);
  };

type CollectInput = Parameters<typeof collectInsightsOverview>[0];
const collect = (
  input: Omit<CollectInput, "getChannels" | "getReleases"> &
    Partial<Pick<CollectInput, "getChannels" | "getReleases">>,
) =>
  collectInsightsOverview({
    getChannels: async () => [{ id: "channel-production", name: "production" }],
    getReleases: async () => [],
    ...input,
  });

const createRuntime = () => ({
  mode: "bounded" as const,
  maxMatchingRows: 50_000,
  appendBundleEvent: vi.fn(),
  getActiveInstallationOverview: vi.fn(),
  getBundleEventSummary: vi.fn(),
  getBundleEventSummaries: vi.fn(),
  getBundleEventInsights: vi.fn(),
  getBundleEventOverview: vi.fn(),
  searchInstallations: vi.fn(),
  getInstallationHistory: vi.fn(),
});

describe("getInsightsCapabilities", () => {
  it("exposes the official database Insights scan boundary", async () => {
    // Given
    const runtime = {
      ...createRuntime(),
      mode: "bounded" as const,
      maxMatchingRows: 50_000,
    };

    // When
    const result = await getInsightsCapabilities(runtime);

    // Then
    expect(result).toEqual({
      capabilities: {
        insights: true,
        mode: "bounded",
        maxMatchingRows: 50_000,
      },
    });
  });

  it("reports support only for the complete callable Insights contract", async () => {
    // Given
    const supported = createRuntime();
    const methodNames = Object.entries(supported)
      .filter(([, value]) => typeof value === "function")
      .map(([name]) => name);

    // When
    const complete = await getInsightsCapabilities(supported);
    const incomplete = await Promise.all(
      methodNames.map((missingMethod) => {
        const runtime = createRuntime();
        Reflect.deleteProperty(runtime, missingMethod);
        return getInsightsCapabilities(runtime);
      }),
    );

    // Then
    expect(complete).toEqual({
      capabilities: {
        insights: true,
        mode: "bounded",
        maxMatchingRows: 50_000,
      },
    });
    expect(incomplete).toEqual(
      methodNames.map(() => ({ capabilities: { insights: false } })),
    );
    for (const method of Object.values(supported).filter(
      (value) => typeof value === "function",
    )) {
      expect(method).not.toHaveBeenCalled();
    }
  });

  it.each([null, undefined, "runtime", 1, { appendBundleEvent: true }])(
    "reports unsupported for invalid runtime %j",
    async (runtime) => {
      // Given / When
      const result = await getInsightsCapabilities(runtime);

      // Then
      expect(result).toEqual({ capabilities: { insights: false } });
    },
  );
});

describe("collectInsightsOverview", () => {
  it("rejects incomplete support before collecting protected data", async () => {
    // Given
    const getBundles = vi.fn();
    const runtime = { ...createRuntime(), searchInstallations: undefined };

    // When
    const result = collect({ runtime, getBundles });

    // Then
    await expect(result).rejects.toThrow(/not supported/i);
    expect(getBundles).not.toHaveBeenCalled();
  });

  it("collects bounded bundle and installation pages into identity-free output", async () => {
    // Given
    const allBundles = [
      createBundle("bundle-a"),
      createBundle("bundle-b"),
      createBundle("bundle-c"),
    ];
    const runtime = createRuntime();
    runtime.getBundleEventOverview.mockResolvedValue({
      trackedInstallations: 3,
      bundles: allBundles.map((bundle) => ({
        bundleId: bundle.id,
        installations: 1,
      })),
    });
    const getBundles = vi.fn(async ({ page }: { page: number }) => ({
      data: [allBundles[page - 1]].filter(
        (bundle): bundle is Bundle => bundle !== undefined,
      ),
      pagination: {
        total: 3,
        currentPage: page,
        totalPages: 3,
        hasNextPage: page < 3,
        hasPreviousPage: page > 1,
      },
    }));

    // When
    const overview = await collect({
      runtime,
      getBundles,
      getReleases: createReleasePager(
        allBundles.map(({ id }) => createRelease(id)),
      ),
      pageSize: 1,
    });

    // Then
    expect(getBundles).toHaveBeenCalledTimes(3);
    expect(runtime.getBundleEventOverview).toHaveBeenCalledOnce();
    expect(runtime.searchInstallations).not.toHaveBeenCalled();
    expect(overview.trackedInstallations).toBe(3);
    expect(overview.configuredRollouts).toHaveLength(3);
    expect(JSON.stringify(overview)).not.toMatch(/private-|user-|install-/);
  });

  it("stops after the first empty source page", async () => {
    // Given
    const runtime = createRuntime();
    runtime.getBundleEventOverview.mockResolvedValue({
      trackedInstallations: 0,
      bundles: [],
    });
    const getBundles = vi.fn(async () => ({
      data: [],
      pagination: {
        total: 0,
        currentPage: 1,
        totalPages: 0,
        hasNextPage: false,
        hasPreviousPage: false,
      },
    }));

    // When
    const overview = await collect({ runtime, getBundles });

    // Then
    expect(runtime.getBundleEventOverview).toHaveBeenCalledOnce();
    expect(overview).toMatchObject({
      trackedInstallations: 0,
      mostCommonLatestReportedBundle: null,
    });
  });

  it.each([0, 2])(
    "rejects a non-advancing current page %i",
    async (currentPage) => {
      // Given
      const runtime = createRuntime();
      const getBundles = vi.fn(async () => ({
        data: [],
        pagination: { currentPage, totalPages: 1, hasNextPage: false },
      }));

      // When
      const result = collect({ runtime, getBundles });

      // Then
      await expect(result).rejects.toBeInstanceOf(
        InsightsBundlePaginationError,
      );
      await expect(result).rejects.toMatchObject({
        name: "InsightsBundlePaginationError",
      });
      expect(runtime.getBundleEventOverview).not.toHaveBeenCalled();
    },
  );

  it.each([Number.NaN, 1.5, -1])(
    "rejects invalid total pages %s",
    async (totalPages) => {
      // Given
      const runtime = createRuntime();
      const getBundles = vi.fn(async () => ({
        data: [],
        pagination: { currentPage: 1, totalPages, hasNextPage: false },
      }));

      // When
      const result = collect({ runtime, getBundles });

      // Then
      await expect(result).rejects.toBeInstanceOf(
        InsightsBundlePaginationError,
      );
      expect(runtime.getBundleEventOverview).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      name: "a next page at the declared last page",
      pages: [
        {
          data: [],
          pagination: {
            currentPage: 1,
            totalPages: 1,
            hasNextPage: true,
          },
        },
      ],
    },
    {
      name: "total pages lower than the current page",
      pages: [
        {
          data: [],
          pagination: {
            currentPage: 1,
            totalPages: 2,
            hasNextPage: true,
          },
        },
        {
          data: [],
          pagination: {
            currentPage: 2,
            totalPages: 1,
            hasNextPage: false,
          },
        },
      ],
    },
  ])("rejects contradictory pagination: $name", async ({ pages }) => {
    // Given
    const runtime = createRuntime();
    const getBundles = vi.fn(
      async ({ page }: { page: number }) => pages[page - 1],
    );

    // When
    const result = collect({ runtime, getBundles });

    // Then
    await expect(result).rejects.toBeInstanceOf(InsightsBundlePaginationError);
    expect(runtime.getBundleEventOverview).not.toHaveBeenCalled();
  });

  it("collects more than 100 bundle pages", async () => {
    // Given
    const runtime = createRuntime();
    runtime.getBundleEventOverview.mockResolvedValue({
      trackedInstallations: 0,
      bundles: [],
    });
    const getBundles = vi.fn(async ({ page }: { page: number }) => ({
      data: [createBundle(`bundle-${page}`)],
      pagination: {
        currentPage: page,
        totalPages: 101,
        hasNextPage: page < 101,
      },
    }));

    // When
    const result = await collect({
      runtime,
      getBundles,
      getReleases: createReleasePager(
        Array.from({ length: 101 }, (_, index) =>
          createRelease(`bundle-${index + 1}`),
        ),
      ),
    });

    // Then
    expect(result.configuredRollouts).toHaveLength(101);
    expect(getBundles).toHaveBeenCalledTimes(101);
  });

  it("collects more than 10,000 bundles", async () => {
    // Given
    const runtime = createRuntime();
    runtime.getBundleEventOverview.mockResolvedValue({
      trackedInstallations: 0,
      bundles: [],
    });
    const getBundles = vi.fn(async () => ({
      data: Array.from({ length: 10_001 }, (_, index) =>
        createBundle(`bundle-${index}`),
      ),
      pagination: {
        currentPage: 1,
        totalPages: 1,
        hasNextPage: false,
      },
    }));

    // When
    const result = await collect({
      runtime,
      getBundles,
      getReleases: createReleasePager(
        Array.from({ length: 10_001 }, (_, index) =>
          createRelease(`bundle-${index}`),
        ),
      ),
    });

    // Then
    expect(result.configuredRollouts).toHaveLength(10_001);
    expect(getBundles).toHaveBeenCalledOnce();
  });
});
