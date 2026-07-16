import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AnalyticsOverview as AnalyticsOverviewData } from "@/lib/analytics-overview";

import { AnalyticsOverview } from "./AnalyticsOverview";

vi.mock("recharts", () => ({
  Bar: () => null,
  BarChart: ({
    children,
    data,
  }: {
    children: React.ReactNode;
    data: readonly unknown[];
  }) => (
    <div data-testid="adoption-chart-data" data-item-count={data.length}>
      {children}
    </div>
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
    expect(
      screen.queryByRole("button", { name: "Next observed bundles page" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Next configured rollouts page" }),
    ).toBeNull();
  });

  it("keeps the adoption card aligned to its own content height", () => {
    // Given / When
    render(<AnalyticsOverview status="success" data={overview} />);

    // Then
    const adoptionCard = screen
      .getByText("Observed bundle adoption")
      .closest('[data-slot="card"]');
    expect(adoptionCard?.className).toContain("self-start");
    expect(adoptionCard?.parentElement?.className).toContain("items-start");
  });

  it("bounds dense adoption and rollout data with navigable inclusive ranges", () => {
    // Given
    const adoption = Array.from({ length: 1205 }, (_, index) => ({
      bundleId: `adoption-${String(index + 1).padStart(4, "0")}`,
      trackedInstallations: 1205 - index,
      observedShare: (1205 - index) / 1205,
      bundle: null,
    }));
    const configuredRollouts = Array.from({ length: 1205 }, (_, index) => ({
      bundleId: `rollout-${String(index + 1).padStart(4, "0")}`,
      configuredPercentage: index % 101,
      trackedInstallations: 1205 - index,
      bundle: {
        platform: "ios" as const,
        channel: "production",
        targetAppVersion: "1.0.0",
        fingerprintHash: null,
      },
    }));

    // When
    render(
      <AnalyticsOverview
        status="success"
        data={{
          trackedInstallations: 1205,
          mostActiveBundle: adoption[0] ?? null,
          adoption,
          configuredRollouts,
        }}
      />,
    );

    // Then
    expect(
      screen.getByText(
        "Showing top 8 of 1,205 observed bundles by tracked installations.",
      ),
    ).toBeDefined();
    expect(
      screen.getByTestId("adoption-chart-data").getAttribute("data-item-count"),
    ).toBe("8");

    const adoptionTable = screen.getByRole("table", {
      name: "Observed adoption details",
    });
    expect(within(adoptionTable).getAllByRole("row")).toHaveLength(9);
    expect(
      screen.getByText("Showing 1–8 of 1,205 observed bundles"),
    ).toBeDefined();
    expect(within(adoptionTable).getByText("adoption-0001")).toBeDefined();
    expect(within(adoptionTable).queryByText("adoption-0009")).toBeNull();

    expect(screen.getAllByRole("progressbar")).toHaveLength(5);
    expect(
      screen.getByText("Showing 1–5 of 1,205 configured rollouts"),
    ).toBeDefined();
    expect(screen.getByText("rollout-0001")).toBeDefined();
    expect(screen.queryByText("rollout-0006")).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Next observed bundles page" }),
    );
    expect(
      screen.getByText("Showing 9–16 of 1,205 observed bundles"),
    ).toBeDefined();
    expect(within(adoptionTable).queryByText("adoption-0001")).toBeNull();
    expect(within(adoptionTable).getByText("adoption-0009")).toBeDefined();

    fireEvent.click(
      screen.getByRole("button", { name: "Next configured rollouts page" }),
    );
    expect(
      screen.getByText("Showing 6–10 of 1,205 configured rollouts"),
    ).toBeDefined();
    expect(screen.queryByText("rollout-0001")).toBeNull();
    expect(screen.getByText("rollout-0006")).toBeDefined();
    expect(screen.getAllByRole("progressbar")).toHaveLength(5);
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
