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
  mostActiveBundle: null,
  adoption: [],
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
        userId="Alias/B"
      />,
    );

    for (const heading of [
      "Active installations",
      "Latest reported bundles",
      "App-ready activity",
      "Update outcomes",
      "Configured rollout",
    ]) {
      expect(
        screen.getByRole("heading", { level: 2, name: heading }),
      ).toBeDefined();
    }
    const activeCard = screen
      .getByText("Active installations")
      .closest('[data-slot="card"]');
    expect(activeCard).not.toBeNull();
    expect(within(activeCard as HTMLElement).getByText("4")).toBeDefined();
    expect(
      screen.getByText("Most common latest reported bundle"),
    ).toBeDefined();
    expect(
      screen
        .getByText("Most common latest reported bundle")
        .closest('[data-slot="card"]'),
    ).toBe(
      screen.getByText("Active installations").closest('[data-slot="card"]'),
    );
    expect(screen.getAllByText("bundle-a").length).toBeGreaterThan(0);
    expect(screen.getAllByText("deleted-bundle").length).toBeGreaterThan(0);
    expect(screen.getByText("Unknown bundle metadata")).toBeDefined();
    expect(screen.getByText("75%")).toBeDefined();
    expect(screen.getAllByText("Installed").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Recovered").length).toBeGreaterThan(0);
    expect(screen.getAllByText("8").length).toBeGreaterThan(0);
    expect(screen.getAllByText("2").length).toBeGreaterThan(0);
    expect(screen.getByText("25% configured")).toBeDefined();
    expect(
      screen.getByTestId("activity-chart").getAttribute("data-points"),
    ).toBe("2");
  });

  it("distinguishes loading, empty, and error states", () => {
    const { rerender } = render(<AnalyticsOverview status="loading" />);
    expect(screen.getByLabelText("Loading active analytics")).toBeDefined();
    for (const label of [
      "Loading active installations",
      "Loading app-ready activity",
      "Loading latest reported bundles",
      "Loading update outcomes",
      "Loading configured rollout",
    ]) {
      expect(screen.getByLabelText(label)).toBeDefined();
    }

    rerender(
      <AnalyticsOverview
        active={{ ...active, activeInstallations: 0, bundles: [] }}
        catalog={catalog}
        outcomes={{ status: "idle" }}
        status="success"
        userId={undefined}
      />,
    );
    expect(
      screen.getByText("No active installation reports in this range."),
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
});
