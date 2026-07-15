import type { Bundle } from "@hot-updater/plugin-core";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BundleAnalyticsSummary } from "./BundleAnalyticsSummary";

const useBundleEventAnalyticsQueryMock = vi.fn();

vi.mock("@/lib/api", () => ({
  useBundleEventAnalyticsQuery: (input: unknown) =>
    useBundleEventAnalyticsQueryMock(input),
}));

vi.mock("@/components/ui/chart", () => ({
  ChartContainer: ({ children }: { children: ReactNode }) => (
    <div data-testid="transition-chart">{children}</div>
  ),
  ChartTooltip: () => null,
  ChartTooltipContent: () => null,
}));

vi.mock("recharts", () => ({
  Area: () => null,
  AreaChart: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CartesianGrid: () => null,
  XAxis: () => null,
  YAxis: () => null,
}));

const bundle: Bundle = {
  id: "01972020-1aa1-7445-8b8c-111111111111",
  channel: "production",
  platform: "ios",
  enabled: true,
  shouldForceUpdate: false,
  fileHash: "abc123",
  storageUri: "s3://bucket/bundle.zip",
  gitCommitHash: null,
  message: "OTA analytics",
  targetAppVersion: "1.0.0",
  fingerprintHash: null,
  rolloutCohortCount: 1000,
  targetCohorts: [],
};

const analytics = {
  summary: { installed: 2, recovered: 1 },
  series: {
    installed: [
      { bucketStartMs: Date.UTC(2026, 6, 14), value: 1 },
      { bucketStartMs: Date.UTC(2026, 6, 15), value: 2 },
    ],
    recovered: [
      { bucketStartMs: Date.UTC(2026, 6, 14), value: 0 },
      { bucketStartMs: Date.UTC(2026, 6, 15), value: 1 },
    ],
  },
  cohorts: { installed: [], recovered: [] },
  recentEvents: {
    data: [],
    pagination: { total: 0, limit: 1, offset: 0 },
  },
};

describe("BundleAnalyticsSummary", () => {
  beforeEach(() => {
    useBundleEventAnalyticsQueryMock.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders lifetime metrics and the 30-day cumulative chart", () => {
    useBundleEventAnalyticsQueryMock.mockReturnValue({
      data: analytics,
      error: null,
      isLoading: false,
    });

    render(<BundleAnalyticsSummary bundle={bundle} />);

    expect(screen.getByText("OTA transitions")).toBeDefined();
    expect(screen.getByText("Installed")).toBeDefined();
    expect(screen.getByText("Recovered")).toBeDefined();
    expect(screen.getByText("2")).toBeDefined();
    expect(screen.getByText("1")).toBeDefined();
    expect(screen.getByTestId("transition-chart")).toBeDefined();
    expect(useBundleEventAnalyticsQueryMock).toHaveBeenCalledWith({
      bundleId: bundle.id,
      window: "30d",
      limit: 1,
      offset: 0,
    });
  });

  it("explains when the selected window has no transition activity", () => {
    useBundleEventAnalyticsQueryMock.mockReturnValue({
      data: {
        ...analytics,
        summary: { installed: 0, recovered: 0 },
        series: {
          installed: analytics.series.installed.map((point) => ({
            ...point,
            value: 0,
          })),
          recovered: analytics.series.recovered.map((point) => ({
            ...point,
            value: 0,
          })),
        },
      },
      error: null,
      isLoading: false,
    });

    render(<BundleAnalyticsSummary bundle={bundle} />);

    expect(
      screen.getByText("No transition activity in the last 30 days."),
    ).toBeDefined();
    expect(screen.queryByTestId("transition-chart")).toBeNull();
  });

  it("renders analytics failures as an alert", () => {
    useBundleEventAnalyticsQueryMock.mockReturnValue({
      data: undefined,
      error: new Error("Transition analytics are not supported."),
      isLoading: false,
    });

    render(<BundleAnalyticsSummary bundle={bundle} />);

    expect(screen.getByRole("alert").textContent).toContain(
      "Transition analytics are not supported.",
    );
  });
});
