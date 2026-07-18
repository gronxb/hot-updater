import type { ActiveInstallationOverview } from "@hot-updater/plugin-core";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AnalyticsOverview as CatalogOverview } from "@/lib/analytics-overview";

import { AnalyticsOverview } from "./AnalyticsOverview";

vi.mock("./ActivityChart", () => ({
  ActivityChart: ({ series }: { series: readonly unknown[] }) => (
    <div data-testid="activity-chart" data-points={series.length} />
  ),
}));

const active: ActiveInstallationOverview = {
  asOfMs: Date.UTC(2026, 6, 18),
  window: "7d",
  activeInstallations: 4,
  series: [
    { bucketStartMs: Date.UTC(2026, 6, 16), value: 2 },
    { bucketStartMs: Date.UTC(2026, 6, 17), value: 0 },
  ],
  bundles: [
    { bundleId: "bundle-a", installations: 3 },
    { bundleId: "deleted-bundle", installations: 1 },
  ],
};

const catalog: CatalogOverview = {
  trackedInstallations: 5,
  mostCommonLatestReportedBundle: null,
  latestReportedBundles: [],
  configuredRollouts: [
    {
      bundleId: "bundle-a",
      configuredPercentage: 25,
      trackedInstallations: 3,
      bundle: {
        platform: "ios",
        channel: "production",
        targetAppVersion: "1.0.0",
        fingerprintHash: null,
      },
    },
  ],
};

const outcomeAnalytics = {
  summary: { installed: 8, recovered: 2 },
  series: {
    installed: [{ bucketStartMs: Date.UTC(2026, 6, 17), value: 8 }],
    recovered: [{ bucketStartMs: Date.UTC(2026, 6, 17), value: 2 }],
  },
  cohorts: { installed: [], recovered: [] },
  recentEvents: {
    data: [],
    pagination: { total: 0, limit: 1, offset: 0 },
  },
};

describe("AnalyticsOverview", () => {
  afterEach(cleanup);

  it("renders the required active analytics sections and exact values", () => {
    render(
      <AnalyticsOverview
        active={active}
        catalog={catalog}
        outcomes={{
          status: "success",
          bundleId: "bundle-a",
          data: outcomeAnalytics,
        }}
        status="success"
      />,
    );

    for (const heading of [
      "Observed installations",
      "Observed by bundle",
      "Selected bundle adoption",
    ]) {
      expect(
        screen.getByRole("heading", { level: 2, name: heading }),
      ).toBeDefined();
    }
    const activityOverview = screen.getByRole("region", {
      name: "Activity overview",
    });
    expect(within(activityOverview).getByText("4")).toBeDefined();
    expect(within(activityOverview).getByText("Bundles")).toBeDefined();
    expect(within(activityOverview).getByText("2")).toBeDefined();
    expect(
      within(activityOverview).getByText("Top observed bundle"),
    ).toBeDefined();
    expect(
      within(activityOverview).getByTestId("activity-chart"),
    ).toBeDefined();
    expect(screen.getAllByText("bundle-a").length).toBeGreaterThan(0);
    expect(screen.getAllByText("deleted-bundle").length).toBeGreaterThan(0);
    expect(screen.getByText("Unknown bundle metadata")).toBeDefined();
    expect(screen.getAllByText("75%").length).toBeGreaterThan(1);
    expect(screen.getAllByText("Newly applied").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Recovered away").length).toBeGreaterThan(0);
    expect(screen.getAllByText("8").length).toBeGreaterThan(0);
    expect(screen.getAllByText("2").length).toBeGreaterThan(0);
    expect(screen.getAllByText("25%").length).toBeGreaterThan(1);
    expect(
      screen.getByTestId("activity-chart").getAttribute("data-points"),
    ).toBe("2");
  });

  it("distinguishes loading, empty, and error states", () => {
    const { rerender } = render(<AnalyticsOverview status="loading" />);
    expect(screen.getByLabelText("Loading observed analytics")).toBeDefined();
    for (const label of [
      "Loading activity overview",
      "Loading bundle activity",
      "Loading selected bundle adoption",
    ]) {
      expect(screen.getByLabelText(label)).toBeDefined();
    }

    rerender(
      <AnalyticsOverview
        active={{ ...active, activeInstallations: 0, bundles: [] }}
        catalog={catalog}
        outcomes={{ status: "idle" }}
        status="success"
      />,
    );
    expect(
      screen.getByText("No observed installations in this range."),
    ).toBeDefined();

    rerender(
      <AnalyticsOverview
        error={new Error("Active request failed")}
        status="error"
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain(
      "Active request failed",
    );
  });

  it("renders dedicated guidance when the bounded Analytics scan is exceeded", () => {
    render(
      <AnalyticsOverview
        error={new Error("Bundle event scan exceeded 50000 rows.")}
        status="error"
      />,
    );

    expect(screen.getByRole("alert").textContent).toContain(
      "Analytics report limit reached",
    );
    expect(screen.getByRole("alert").textContent).toContain("50,000 reports");
  });

  it("shows the observed count for a one-install leading bundle", () => {
    render(
      <AnalyticsOverview
        active={{
          ...active,
          activeInstallations: 1,
          bundles: [{ bundleId: "bundle-a", installations: 1 }],
        }}
        catalog={catalog}
        outcomes={{ status: "idle" }}
        status="success"
      />,
    );

    expect(
      within(
        screen.getByRole("region", { name: "Activity overview" }),
      ).getByText("1 seen"),
    ).toBeDefined();
  });
});
