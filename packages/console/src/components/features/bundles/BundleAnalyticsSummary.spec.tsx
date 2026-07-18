import type { Bundle } from "@hot-updater/plugin-core";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AnalyticsCapabilityState } from "@/lib/analytics-api";

import { BundleAnalyticsSummary } from "./BundleAnalyticsSummary";

const useBundleEventAnalyticsQueryMock = vi.fn();

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

const supported = { status: "supported", mode: "dedicated" } as const;

const capability = (
  status: AnalyticsCapabilityState["status"],
): AnalyticsCapabilityState => {
  switch (status) {
    case "error":
      return { status, error: new Error("offline") };
    case "supported":
      return { status, mode: "dedicated" };
    case "unsupported":
    case "unresolved":
      return { status };
  }
};

describe("BundleAnalyticsSummary", () => {
  beforeEach(() => {
    useBundleEventAnalyticsQueryMock.mockReset();
  });

  afterEach(cleanup);

  it.each(["unresolved", "unsupported", "error"] as const)(
    "mounts no card or query while capability is %s",
    (status) => {
      render(
        <BundleAnalyticsSummary
          bundle={bundle}
          capability={capability(status)}
        />,
      );

      expect(screen.queryByText("Bundle movement · 30 days")).toBeNull();
      expect(useBundleEventAnalyticsQueryMock).not.toHaveBeenCalled();
    },
  );

  it("renders compact loading feedback after support is confirmed", () => {
    useBundleEventAnalyticsQueryMock.mockReturnValue({
      data: undefined,
      error: null,
      isLoading: true,
    });

    render(<BundleAnalyticsSummary bundle={bundle} capability={supported} />);

    expect(
      screen.getByLabelText("Loading reported bundle outcomes"),
    ).toBeDefined();
  });

  it("renders selected-period metrics and the accessible movement chart", () => {
    useBundleEventAnalyticsQueryMock.mockReturnValue({
      data: analytics,
      error: null,
      isLoading: false,
    });

    render(<BundleAnalyticsSummary bundle={bundle} capability={supported} />);

    expect(screen.getByText("Bundle movement · 30 days")).toBeDefined();
    expect(screen.getAllByText("Newly applied")).toBeDefined();
    expect(screen.getAllByText("Recovered away")).toBeDefined();
    expect(screen.getAllByText("2")).toBeDefined();
    expect(screen.getAllByText("1")).toBeDefined();
    const chart = screen.getByRole("img", {
      name: "Bundle movement over 30 days",
    });
    const caption = screen.getByText(
      "Distinct bundle movement in each bucket over 30 days. Times are shown in UTC.",
    );

    expect(chart.getAttribute("aria-describedby")).toBe(caption.id);
    expect(screen.getByRole("row", { name: "Jul 14 1 0" })).toBeDefined();
    expect(screen.getByRole("row", { name: "Jul 15 2 1" })).toBeDefined();
    expect(screen.queryByText("Lifetime")).toBeNull();
    expect(screen.queryByText("30-day activity")).toBeNull();
    expect(useBundleEventAnalyticsQueryMock).toHaveBeenCalledWith(
      {
        bundleId: bundle.id,
        window: "30d",
        limit: 1,
        offset: 0,
      },
      true,
    );
  });

  it("explains when the selected window has no activity", () => {
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

    render(<BundleAnalyticsSummary bundle={bundle} capability={supported} />);

    expect(
      screen.getByText("No bundle movement in this period."),
    ).toBeDefined();
    expect(screen.queryByTestId("activity-chart")).toBeNull();
  });

  it("renders supported analytics failures as an alert", () => {
    useBundleEventAnalyticsQueryMock.mockReturnValue({
      data: undefined,
      error: new Error("Analytics request failed."),
      isLoading: false,
    });

    render(<BundleAnalyticsSummary bundle={bundle} capability={supported} />);

    expect(screen.getByRole("alert").textContent).toContain(
      "Analytics request failed.",
    );
  });

  it("renders dedicated guidance when the bounded Analytics scan is exceeded", () => {
    useBundleEventAnalyticsQueryMock.mockReturnValue({
      data: undefined,
      error: new Error("Bundle event scan exceeded 50000 rows."),
      isLoading: false,
    });

    render(<BundleAnalyticsSummary bundle={bundle} capability={supported} />);

    expect(screen.getByRole("alert").textContent).toContain(
      "Analytics report limit reached",
    );
  });
});
