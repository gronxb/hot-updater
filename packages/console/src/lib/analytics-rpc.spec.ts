// @vitest-environment node

import type { Bundle } from "@hot-updater/plugin-core";
import { describe, expect, it, vi } from "vitest";

import {
  collectAnalyticsOverview,
  getAnalyticsCapabilities,
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

const createRuntime = () => ({
  appendBundleEvent: vi.fn(),
  getBundleEventSummary: vi.fn(),
  getBundleEventAnalytics: vi.fn(),
  getBundleEventOverview: vi.fn(),
  searchInstallations: vi.fn(),
  getInstallationHistory: vi.fn(),
});

describe("getAnalyticsCapabilities", () => {
  it("reports support only for the complete callable bundle-event contract", async () => {
    // Given
    const supported = createRuntime();
    const methodNames = Object.keys(supported);

    // When
    const complete = await getAnalyticsCapabilities(supported);
    const incomplete = await Promise.all(
      methodNames.map((missingMethod) => {
        const runtime = createRuntime();
        Reflect.deleteProperty(runtime, missingMethod);
        return getAnalyticsCapabilities(runtime);
      }),
    );

    // Then
    expect(complete).toEqual({ supportsBundleEvents: true });
    expect(incomplete).toEqual(
      methodNames.map(() => ({ supportsBundleEvents: false })),
    );
    for (const method of Object.values(supported)) {
      expect(method).not.toHaveBeenCalled();
    }
  });

  it.each([null, undefined, "runtime", 1, { appendBundleEvent: true }])(
    "reports unsupported for invalid runtime %j",
    async (runtime) => {
      // Given / When
      const result = await getAnalyticsCapabilities(runtime);

      // Then
      expect(result).toEqual({ supportsBundleEvents: false });
    },
  );
});

describe("collectAnalyticsOverview", () => {
  it("rejects incomplete support before collecting protected data", async () => {
    // Given
    const getBundles = vi.fn();
    const runtime = { ...createRuntime(), searchInstallations: undefined };

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
      mostActiveBundle: null,
    });
  });
});
