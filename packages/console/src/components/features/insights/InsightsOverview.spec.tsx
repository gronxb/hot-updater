import type { ActiveInstallationOverview } from "@hot-updater/server";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { InsightsOverview as CatalogOverview } from "@/lib/insights-overview";

import { InsightsOverview } from "./InsightsOverview";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));

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
  bundleSeries: [
    {
      bundleId: "bundle-a",
      series: [
        { bucketStartMs: Date.UTC(2026, 6, 16), value: 2 },
        { bucketStartMs: Date.UTC(2026, 6, 17), value: 0 },
      ],
    },
    {
      bundleId: "deleted-bundle",
      series: [
        { bucketStartMs: Date.UTC(2026, 6, 16), value: 0 },
        { bucketStartMs: Date.UTC(2026, 6, 17), value: 1 },
      ],
    },
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
      releaseId: "release-a",
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

const outcomeInsights = {
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

describe("InsightsOverview", () => {
  afterEach(cleanup);

  it("renders the required active insights sections and exact values", () => {
    render(
      <InsightsOverview
        active={active}
        bundleId="bundle-a"
        bundles={[
          { bundleId: "bundle-a", description: "iOS · production · 1.0.0" },
          { bundleId: "deleted-bundle", description: "Metadata unavailable" },
        ]}
        catalog={catalog}
        onBundleChange={vi.fn()}
        outcomes={{
          status: "success",
          bundleId: "bundle-a",
          data: outcomeInsights,
        }}
        status="success"
      />,
    );

    for (const heading of [
      "Weekly active installations",
      "Selected bundle activity",
    ]) {
      expect(
        screen.getByRole("heading", { level: 2, name: heading }),
      ).toBeDefined();
    }
    const activityOverview = screen.getByRole("region", {
      name: "Installation activity",
    });
    expect(within(activityOverview).getByText("4")).toBeDefined();
    expect(
      within(activityOverview).getByText("Reported bundles"),
    ).toBeDefined();
    expect(within(activityOverview).getByText("2")).toBeDefined();
    expect(within(activityOverview).queryByText("Reporting window")).toBeNull();
    expect(activityOverview.textContent).toContain(
      "reported activity or an update in the last 7 days",
    );
    expect(
      within(activityOverview).getByTestId("activity-chart"),
    ).toBeDefined();
    expect(screen.getAllByText("Newly applied").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Recovered away").length).toBeGreaterThan(0);
    expect(screen.getAllByText("8", { exact: false }).length).toBeGreaterThan(
      0,
    );
    expect(screen.getAllByText("2").length).toBeGreaterThan(0);
    expect(
      screen.getByText("Configured rollout").nextElementSibling?.textContent,
    ).toBe("25%");
    expect(
      screen.getByTestId("activity-chart").getAttribute("data-points"),
    ).toBe("2");

    const bundleActivityHeading = screen.getByRole("heading", {
      level: 2,
      name: "Selected bundle activity",
    });
    const bundleSelector = screen.getByRole("combobox", {
      name: "Artifact to inspect",
    });
    expect(bundleSelector.closest('[data-slot="card"]')).toBe(
      bundleActivityHeading.closest('[data-slot="card"]'),
    );
  });

  it("distinguishes loading, empty, and error states", () => {
    const { rerender } = render(<InsightsOverview status="loading" />);
    expect(screen.getByLabelText("Loading reporting insights")).toBeDefined();
    for (const label of [
      "Loading installation activity",
      "Loading bundle detail",
    ]) {
      expect(screen.getByLabelText(label)).toBeDefined();
    }

    rerender(
      <InsightsOverview
        active={{
          ...active,
          activeInstallations: 0,
          bundles: [],
          bundleSeries: [],
        }}
        bundleId=""
        bundles={[]}
        catalog={catalog}
        onBundleChange={vi.fn()}
        outcomes={{ status: "idle" }}
        status="success"
      />,
    );
    expect(screen.getByTestId("activity-chart")).toBeDefined();

    rerender(
      <InsightsOverview
        error={new Error("Active request failed")}
        status="error"
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain(
      "Refresh to try again",
    );
  });

  it("renders narrowing guidance when the bounded Insights scan is exceeded", () => {
    render(
      <InsightsOverview
        error={new Error("Bundle event scan exceeded 50000 rows.")}
        status="error"
      />,
    );

    expect(screen.getByRole("alert").textContent).toContain(
      "Insights report limit reached",
    );
    expect(screen.getByRole("alert").textContent).toContain("50,000 events");
  });

  it("names the 30-day metric as monthly active installations", () => {
    render(
      <InsightsOverview
        active={{
          ...active,
          window: "30d",
          activeInstallations: 1,
          bundles: [{ bundleId: "bundle-a", installations: 1 }],
        }}
        bundleId="bundle-a"
        bundles={[
          { bundleId: "bundle-a", description: "iOS · production · 1.0.0" },
        ]}
        catalog={catalog}
        onBundleChange={vi.fn()}
        outcomes={{ status: "idle" }}
        status="success"
      />,
    );

    expect(
      within(
        screen.getByRole("region", { name: "Installation activity" }),
      ).getByRole("heading", { name: "Monthly active installations" }),
    ).toBeDefined();
  });
});
