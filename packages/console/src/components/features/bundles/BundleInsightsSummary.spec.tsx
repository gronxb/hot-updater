import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { InsightsCapabilityState } from "@/lib/insights-api";

import { BundleInsightsSummary } from "./BundleInsightsSummary";

const useBundleEventInsightsQueryMock = vi.fn();
let insightsCapability: InsightsCapabilityState = { status: "unresolved" };

vi.mock("@/components/features/insights/InsightsCapabilityContext", () => ({
  useInsightsCapability: () => insightsCapability,
}));

vi.mock("@/lib/api", () => ({
  useBundleEventInsightsQuery: (input: unknown, enabled: boolean) =>
    useBundleEventInsightsQueryMock(input, enabled),
}));

vi.mock("@/components/ui/chart", () => ({
  ChartContainer: ({ children, ...props }: { children: ReactNode }) => (
    <div data-testid="activity-chart" {...props}>
      {children}
    </div>
  ),
  ChartTooltip: () => null,
  ChartTooltipContent: () => null,
  ChartLegend: () => null,
  ChartLegendContent: () => null,
}));

vi.mock("recharts", () => ({
  Area: () => null,
  AreaChart: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CartesianGrid: () => null,
  XAxis: () => null,
  YAxis: () => null,
}));

const bundleId = "01972020-1aa1-7445-8b8c-111111111111";

const insights = {
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

describe("BundleInsightsSummary", () => {
  beforeEach(() => {
    insightsCapability = { status: "unresolved" };
    useBundleEventInsightsQueryMock.mockReset();
  });

  afterEach(cleanup);

  it("does not query or render when Insights is unavailable", () => {
    render(<BundleInsightsSummary bundleId={bundleId} />);

    expect(screen.queryByText("Activity · 30 days")).toBeNull();
    expect(useBundleEventInsightsQueryMock).not.toHaveBeenCalled();
  });

  it("renders the selected bundle's 30-day movement summary", () => {
    insightsCapability = {
      status: "supported",
      mode: "bounded",
      maxMatchingRows: 50_000,
    };
    useBundleEventInsightsQueryMock.mockReturnValue({
      data: insights,
      error: null,
      isLoading: false,
    });

    render(<BundleInsightsSummary bundleId={bundleId} />);

    expect(screen.getByText("Activity · 30 days")).toBeDefined();
    expect(screen.getAllByText("Applied").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Recovered").length).toBeGreaterThan(0);
    expect(
      screen.getByRole("img", { name: "Bundle movement over 30 days" }),
    ).toBeDefined();
    expect(useBundleEventInsightsQueryMock).toHaveBeenCalledWith(
      {
        bundleId,
        window: "30d",
        limit: 1,
        offset: 0,
      },
      true,
    );
  });

  it("renders Insights failures inside the summary card", () => {
    insightsCapability = {
      status: "supported",
      mode: "bounded",
      maxMatchingRows: 50_000,
    };
    useBundleEventInsightsQueryMock.mockReturnValue({
      data: undefined,
      error: new Error("Insights request failed."),
      isLoading: false,
    });

    render(<BundleInsightsSummary bundleId={bundleId} />);

    expect(screen.getByRole("alert").textContent).toContain(
      "Refresh to try again",
    );
  });
});
