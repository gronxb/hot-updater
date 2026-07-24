// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import {
  getAnalyticsCapabilities,
  parseProbedAnalyticsCapabilities,
} from "./analytics-rpc";

const ANALYTICS_METHODS = [
  "appendBundleEvent",
  "getActiveInstallationOverview",
  "getBundleEventSummary",
  "getBundleEventAnalytics",
  "getBundleEventOverview",
  "searchInstallations",
  "getInstallationHistory",
] as const;

const createRuntime = (
  capabilities: object = {
    analytics: true,
    analyticsQueries: true,
    eventIngestion: true,
    mode: "dedicated",
  },
) => {
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
      Response.json({ capabilities, version: "test" }),
    ),
  };
};

describe("getAnalyticsCapabilities", () => {
  it("uses version metadata before exposing Analytics", async () => {
    // Given
    const runtime = createRuntime({
      analytics: false,
      analyticsQueries: false,
      eventIngestion: false,
    });

    // When
    const result = await getAnalyticsCapabilities(runtime);

    // Then
    expect(result).toEqual({ capabilities: { analytics: false } });
    expect(runtime.handler).toHaveBeenCalledOnce();
  });

  it("preserves route-aware bounded capability metadata", async () => {
    // Given
    const runtime = createRuntime({
      analytics: true,
      mode: "bounded",
      maxMatchingRows: 12_345,
      eventIngestion: false,
      analyticsQueries: true,
    });

    // When
    const result = getAnalyticsCapabilities(runtime);

    // Then
    await expect(result).resolves.toEqual({
      capabilities: {
        analytics: true,
        mode: "bounded",
        maxMatchingRows: 12_345,
      },
    });
  });

  it("exposes the CRUD-derived Analytics scan boundary", async () => {
    // Given
    const runtime = createRuntime({
      analytics: true,
      mode: "bounded",
      maxMatchingRows: 50_000,
      eventIngestion: true,
      analyticsQueries: true,
    });

    // When
    const result = await getAnalyticsCapabilities(runtime);

    // Then
    expect(result).toEqual({
      capabilities: {
        analytics: true,
        mode: "bounded",
        maxMatchingRows: 50_000,
      },
    });
  });

  it("reports support only for the complete callable Analytics contract", async () => {
    // Given
    const supported = createRuntime();

    // When
    const complete = await getAnalyticsCapabilities(supported);
    const incomplete = await Promise.all(
      ANALYTICS_METHODS.map((missingMethod) => {
        const runtime = createRuntime();
        Reflect.deleteProperty(runtime.features.analytics, missingMethod);
        return getAnalyticsCapabilities(runtime);
      }),
    );

    // Then
    expect(complete).toEqual({
      capabilities: { analytics: true, mode: "dedicated" },
    });
    expect(incomplete).toEqual(
      ANALYTICS_METHODS.map(() => ({ capabilities: { analytics: false } })),
    );
    for (const method of ANALYTICS_METHODS.map(
      (name) => supported.features.analytics[name],
    )) {
      expect(method).not.toHaveBeenCalled();
    }
  });

  it.each([null, undefined, "runtime", 1, { appendBundleEvent: true }])(
    "reports unsupported for invalid runtime %j",
    async (runtime) => {
      // Given / When
      const result = await getAnalyticsCapabilities(runtime);

      // Then
      expect(result).toEqual({ capabilities: { analytics: false } });
    },
  );
});

describe("getAnalyticsCapabilities remote route discovery", () => {
  it.each([
    {
      name: "dedicated queries are mounted",
      reported: {
        analytics: true,
        mode: "dedicated",
        eventIngestion: false,
        analyticsQueries: true,
      },
      expected: { analytics: true, mode: "dedicated" },
    },
    {
      name: "bounded queries are mounted",
      reported: {
        analytics: true,
        mode: "bounded",
        maxMatchingRows: 50_000,
        eventIngestion: true,
        analyticsQueries: true,
      },
      expected: {
        analytics: true,
        mode: "bounded",
        maxMatchingRows: 50_000,
      },
    },
    {
      name: "only ingestion is mounted",
      reported: {
        analytics: true,
        mode: "dedicated",
        eventIngestion: true,
        analyticsQueries: false,
      },
      expected: { analytics: false },
    },
    {
      name: "a legacy response omits route availability",
      reported: { analytics: true, mode: "dedicated" },
      expected: { analytics: false },
    },
    {
      name: "a partial response omits ingestion availability",
      reported: {
        analytics: true,
        mode: "dedicated",
        analyticsQueries: true,
      },
      expected: { analytics: false },
    },
  ] as const)(
    "reports query capability when $name",
    ({ reported, expected }) => {
      // Given
      const capabilities: unknown = reported;

      // When
      const result = parseProbedAnalyticsCapabilities(capabilities);

      // Then
      expect(result).toEqual(expected);
    },
  );
});
