import { vi } from "vitest";

import type { AnalyticsProvider } from "../provider";

export const createTestProvider = (): AnalyticsProvider => ({
  appendBundleEvent: vi.fn(async () => undefined),
  getActiveInstallationOverview: vi.fn(async (input) => ({
    activeInstallations: 0,
    asOfMs: 1_752_754_600_000,
    bundles: [],
    bundleSeries: [],
    series: [],
    window: input.window,
  })),
  getBundleEventAnalytics: vi.fn(async (_bundleId, _window, limit, offset) => ({
    cohorts: { installed: [], recovered: [] },
    recentEvents: {
      data: [],
      pagination: { limit, offset, total: 0 },
    },
    series: { installed: [], recovered: [] },
    summary: { installed: 0, recovered: 0 },
  })),
  getBundleEventOverview: vi.fn(async () => ({
    bundles: [],
    trackedInstallations: 0,
  })),
  getBundleEventSummary: vi.fn(async () => ({
    installed: 0,
    recovered: 0,
  })),
  getInstallationHistory: vi.fn(async (_installId, limit, offset) => ({
    data: [],
    pagination: { limit, offset, total: 0 },
  })),
  mode: "dedicated",
  searchInstallations: vi.fn(async (_query, limit, offset) => ({
    data: [],
    pagination: { limit, offset, total: 0 },
  })),
});
