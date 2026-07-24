// @vitest-environment node

import type { Bundle } from "@hot-updater/plugin-core";
import { describe, expect, it, vi } from "vitest";

import {
  AnalyticsBundlePaginationError,
  collectAnalyticsOverview,
} from "./analytics-rpc";

const createBundle = (id: string): Bundle => ({
  id,
  channel: "production",
  platform: "ios",
  enabled: true,
  shouldForceUpdate: false,
  fileHash: `hash-${id}`,
  storageUri: `storage://${id}.zip`,
  gitCommitHash: null,
  message: null,
  targetAppVersion: "1.0.0",
  fingerprintHash: null,
  rolloutCohortCount: 1000,
});

const createRuntime = () => {
  const methods = {
    appendBundleEvent: vi.fn(),
    getActiveInstallationOverview: vi.fn(),
    getBundleEventSummary: vi.fn(),
    getBundleEventAnalytics: vi.fn(),
    getBundleEventOverview: vi.fn(),
    searchInstallations: vi.fn(),
    getInstallationHistory: vi.fn(),
  };
  return {
    ...methods,
    basePath: "/api",
    features: {
      analytics: {
        ...methods,
        status: "available",
      },
    },
    handler: vi.fn(async () =>
      Response.json({
        capabilities: {
          analytics: true,
          analyticsQueries: true,
          eventIngestion: true,
          mode: "dedicated",
        },
        version: "test",
      }),
    ),
  };
};

describe("collectAnalyticsOverview", () => {
  it("rejects incomplete support before collecting protected data", async () => {
    // Given
    const getBundles = vi.fn();
    const runtime = {
      ...createRuntime(),
      features: {
        analytics: {
          reason: "missing-provider-capability",
          status: "unavailable",
        },
      },
    };

    // When
    const result = collectAnalyticsOverview({ runtime, getBundles });

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
    const overview = await collectAnalyticsOverview({
      runtime,
      getBundles,
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
    const overview = await collectAnalyticsOverview({ runtime, getBundles });

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
      const result = collectAnalyticsOverview({ runtime, getBundles });

      // Then
      await expect(result).rejects.toBeInstanceOf(
        AnalyticsBundlePaginationError,
      );
      await expect(result).rejects.toMatchObject({
        name: "AnalyticsBundlePaginationError",
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
      const result = collectAnalyticsOverview({ runtime, getBundles });

      // Then
      await expect(result).rejects.toBeInstanceOf(
        AnalyticsBundlePaginationError,
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
    const result = collectAnalyticsOverview({ runtime, getBundles });

    // Then
    await expect(result).rejects.toBeInstanceOf(AnalyticsBundlePaginationError);
    expect(runtime.getBundleEventOverview).not.toHaveBeenCalled();
  });

  it("rejects a declared page count above the collection cap", async () => {
    // Given
    const runtime = createRuntime();
    const getBundles = vi.fn(async () => ({
      data: [],
      pagination: {
        currentPage: 1,
        totalPages: 101,
        hasNextPage: true,
      },
    }));

    // When
    const result = collectAnalyticsOverview({ runtime, getBundles });

    // Then
    await expect(result).rejects.toBeInstanceOf(AnalyticsBundlePaginationError);
    expect(getBundles).toHaveBeenCalledOnce();
    expect(runtime.getBundleEventOverview).not.toHaveBeenCalled();
  });

  it("rejects a page that would exceed the bundle collection cap", async () => {
    // Given
    const runtime = createRuntime();
    const bundle = createBundle("bundle-a");
    const getBundles = vi.fn(async () => ({
      data: Array.from({ length: 10_001 }, () => bundle),
      pagination: {
        currentPage: 1,
        totalPages: 1,
        hasNextPage: false,
      },
    }));

    // When
    const result = collectAnalyticsOverview({ runtime, getBundles });

    // Then
    await expect(result).rejects.toBeInstanceOf(AnalyticsBundlePaginationError);
    expect(getBundles).toHaveBeenCalledOnce();
    expect(runtime.getBundleEventOverview).not.toHaveBeenCalled();
  });
});
