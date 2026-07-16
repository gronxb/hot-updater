import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AnalyticsOverview as AnalyticsOverviewData } from "@/lib/analytics-overview";

import { AnalyticsOverview } from "./AnalyticsOverview";

vi.mock("recharts", () => ({
  Bar: () => null,
  BarChart: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  CartesianGrid: () => null,
  XAxis: () => null,
  YAxis: () => null,
}));

vi.mock("@/components/ui/chart", () => ({
  ChartContainer: ({ children, ...props }: React.ComponentProps<"div">) => (
    <div {...props}>{children}</div>
  ),
  ChartTooltip: () => null,
  ChartTooltipContent: () => null,
}));

const overview: AnalyticsOverviewData = {
  trackedInstallations: 4,
  mostActiveBundle: {
    bundleId: "bundle-a",
    trackedInstallations: 2,
    observedShare: 0.5,
    bundle: {
      platform: "ios",
      channel: "production",
      targetAppVersion: "1.0.0",
      fingerprintHash: null,
    },
  },
  adoption: [
    {
      bundleId: "bundle-a",
      trackedInstallations: 2,
      observedShare: 0.5,
      bundle: {
        platform: "ios",
        channel: "production",
        targetAppVersion: "1.0.0",
        fingerprintHash: null,
      },
    },
    {
      bundleId: "deleted-bundle",
      trackedInstallations: 1,
      observedShare: 0.25,
      bundle: null,
    },
  ],
  configuredRollouts: [
    {
      bundleId: "bundle-a",
      configuredPercentage: 100,
      trackedInstallations: 2,
      bundle: {
        platform: "ios",
        channel: "production",
        targetAppVersion: "1.0.0",
        fingerprintHash: null,
      },
    },
  ],
};

describe("AnalyticsOverview", () => {
  afterEach(cleanup);

  it("renders layout-stable loading feedback", () => {
    render(<AnalyticsOverview status="loading" />);

    expect(screen.getByLabelText("Loading analytics overview")).toBeDefined();
  });

  it("renders exact tracked adoption and configured rollout values", () => {
    render(<AnalyticsOverview status="success" data={overview} />);

    expect(screen.getByText("4")).toBeDefined();
    expect(screen.getByText("Most active observed bundle")).toBeDefined();
    expect(screen.getAllByText("bundle-a").length).toBeGreaterThan(0);
    expect(screen.getAllByText("2 tracked · 50%").length).toBeGreaterThan(0);
    expect(screen.getByText("deleted-bundle")).toBeDefined();
    expect(screen.getByText("Bundle metadata unavailable")).toBeDefined();
    expect(screen.getByText("100% configured")).toBeDefined();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe(
      "100",
    );
    expect(screen.getByLabelText("Observed bundle adoption")).toBeDefined();
  });

  it("explains when no installation reports are tracked", () => {
    render(
      <AnalyticsOverview
        status="success"
        data={{
          ...overview,
          trackedInstallations: 0,
          mostActiveBundle: null,
          adoption: [],
        }}
      />,
    );

    expect(
      screen.getByText("No tracked installation reports are available yet."),
    ).toBeDefined();
    expect(screen.queryByText("Most active observed bundle")).toBeNull();
  });

  it("renders a genuine overview error", () => {
    render(
      <AnalyticsOverview
        status="error"
        error={new Error("Overview request failed")}
      />,
    );

    expect(screen.getByRole("alert").textContent).toContain(
      "Overview request failed",
    );
  });
});
