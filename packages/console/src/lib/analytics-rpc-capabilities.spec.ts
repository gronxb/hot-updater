// @vitest-environment node

import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  getAnalyticsCapabilities,
  parseProbedAnalyticsCapabilities,
} from "./analytics-rpc";

const createRuntime = () => ({
  appendBundleEvent: vi.fn(),
  getActiveInstallationOverview: vi.fn(),
  getBundleEventSummary: vi.fn(),
  getBundleEventAnalytics: vi.fn(),
  getBundleEventOverview: vi.fn(),
  searchInstallations: vi.fn(),
  getInstallationHistory: vi.fn(),
});

beforeAll(async () => {
  await import("@hot-updater/server/db");
});

describe("getAnalyticsCapabilities", () => {
  it("uses an internal remote capability probe before exposing Analytics", async () => {
    // Given
    const probe = vi.fn().mockResolvedValue({ analytics: false as const });
    const runtime = Object.assign(createRuntime(), {
      [Symbol.for("@hot-updater/internal/analytics-capability-probe")]: probe,
    });

    // When
    const result = await getAnalyticsCapabilities(runtime);

    // Then
    expect(result).toEqual({ capabilities: { analytics: false } });
    expect(probe).toHaveBeenCalledOnce();
  });

  it("preserves route-aware bounded capability metadata", async () => {
    // Given
    const runtime = Object.assign(createRuntime(), {
      [Symbol.for("@hot-updater/internal/analytics-capability-probe")]: () =>
        Promise.resolve({
          analytics: true as const,
          mode: "bounded" as const,
          maxMatchingRows: 12_345,
          eventIngestion: false,
          analyticsQueries: true,
        }),
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
    const runtime = Object.assign(createRuntime(), {
      [Symbol.for("@hot-updater/server/analytics-capability")]: {
        mode: "bounded",
        maxMatchingRows: 50_000,
      },
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
    expect(complete).toEqual({
      capabilities: { analytics: true, mode: "dedicated" },
    });
    expect(incomplete).toEqual(
      methodNames.map(() => ({ capabilities: { analytics: false } })),
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
