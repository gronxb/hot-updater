import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AnalyticsCapabilityState } from "@/lib/analytics-api";

import { BundleAnalyticsSummary } from "./BundleAnalyticsSummary";

const useBundleEventAnalyticsQueryMock = vi.fn();
let analyticsCapability: AnalyticsCapabilityState = { status: "unresolved" };

vi.mock("@/components/features/analytics/AnalyticsCapabilityContext", () => ({
  useAnalyticsCapability: () => analyticsCapability,
}));

vi.mock("@/lib/api", () => ({
  useBundleEventAnalyticsQuery: (input: unknown, enabled: boolean) =>
    useBundleEventAnalyticsQueryMock(input, enabled),
}));

vi.mock("@/components/ui/chart", () => ({
  ChartContainer: ({ children, ...props }: { children: ReactNode }) => (
    <div data-testid="activity-chart" {...props}>
      {children}
    </div>
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

const bundleId = "01972020-1aa1-7445-8b8c-111111111111";

const analytics = {
  summary: { installed: 2, recovered: 1 },
  series: {
    installed: [{ bucketStartMs: Date.UTC(2026, 6, 15), value: 2 }],
    recovered: [{ bucketStartMs: Date.UTC(2026, 6, 15), value: 1 }],
  },
  cohorts: { installed: [], recovered: [] },
  recentEvents: {
    data: [],
    pagination: { total: 0, limit: 1, offset: 0 },
  },
};

describe("BundleAnalyticsSummary", () => {
  beforeEach(() => {
    analyticsCapability = { status: "unresolved" };
    useBundleEventAnalyticsQueryMock.mockReset();
  });

  afterEach(cleanup);

  it("does not query or render when Analytics is unavailable", () => {
    render(<BundleAnalyticsSummary bundleId={bundleId} />);

    expect(screen.queryByText("Bundle Movement · 30 Days")).toBeNull();
    expect(useBundleEventAnalyticsQueryMock).not.toHaveBeenCalled();
  });

  it("renders the selected bundle's 30-day movement summary", () => {
    analyticsCapability = {
      status: "supported",
      mode: "bounded",
      maxMatchingRows: 50_000,
    };
    useBundleEventAnalyticsQueryMock.mockReturnValue({
      data: analytics,
      error: null,
      isLoading: false,
    });

    render(<BundleAnalyticsSummary bundleId={bundleId} />);

    expect(screen.getByText("Bundle Movement · 30 Days")).toBeDefined();
    expect(screen.getAllByText("Newly applied").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Recovered away").length).toBeGreaterThan(0);
    expect(
      screen.getByRole("img", { name: "Bundle movement over 30 days" }),
    ).toBeDefined();
    expect(useBundleEventAnalyticsQueryMock).toHaveBeenCalledWith(
      {
        bundleId,
        window: "30d",
        limit: 1,
        offset: 0,
      },
      true,
    );
  });

  it("renders Analytics failures inside the summary card", () => {
    analyticsCapability = {
      status: "supported",
      mode: "bounded",
      maxMatchingRows: 50_000,
    };
    useBundleEventAnalyticsQueryMock.mockReturnValue({
      data: undefined,
      error: new Error("Analytics request failed."),
      isLoading: false,
    });

    render(<BundleAnalyticsSummary bundleId={bundleId} />);

    expect(screen.getByRole("alert").textContent).toContain(
      "Analytics request failed.",
    );
  });
});
