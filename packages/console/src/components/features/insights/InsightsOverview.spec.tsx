import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

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
vi.mock("../bundles/BundleActivityChart", () => ({
  BundleActivityChart: () => <div data-testid="bundle-activity-chart" />,
}));

const active = {
  activeInstallations: 4,
  asOfMs: Date.UTC(2026, 6, 18),
  reportedBundles: 2,
  series: [
    { bucketStartMs: Date.UTC(2026, 6, 16), value: 2 },
    { bucketStartMs: Date.UTC(2026, 6, 17), value: 4 },
  ],
  window: "7d" as const,
};

const successProps = {
  active,
  bundleSelector: (
    <select aria-label="Artifact to inspect" defaultValue="bundle-a">
      <option value="bundle-a">Bundle A</option>
    </select>
  ),
  configuredPercentage: 25,
  latestBundleInstallations: 3,
  outcomes: {
    status: "success" as const,
    bundleId: "bundle-a",
    data: {
      summary: { installed: 8, recovered: 2 },
      series: { installed: [], recovered: [] },
    },
  },
  trackedInstallations: 5,
};

describe("InsightsOverview", () => {
  afterEach(cleanup);

  it("renders exact activity and selected-bundle metrics", () => {
    render(<InsightsOverview status="success" {...successProps} />);
    const activity = screen.getByRole("region", {
      name: "Installation activity",
    });
    expect(within(activity).getByText("4")).toBeDefined();
    expect(within(activity).getByText("Tracked bundles")).toBeDefined();
    expect(within(activity).getByText("2")).toBeDefined();
    expect(
      screen.getByRole("heading", { name: "Weekly active installations" }),
    ).toBeDefined();
    expect(
      screen.getByRole("heading", { name: "Selected bundle activity" }),
    ).toBeDefined();
    expect(screen.getByText("25")).toBeDefined();
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

  it("distinguishes loading and request failures", () => {
    const view = render(<InsightsOverview status="loading" />);
    expect(screen.getByLabelText("Loading reporting insights")).toBeDefined();
    view.rerender(
      <InsightsOverview status="error" error={new Error("request failed")} />,
    );
    expect(screen.getByRole("alert").textContent).toContain(
      "Refresh to try again",
    );
  });

  it("uses the monthly label for a 30-day window", () => {
    render(
      <InsightsOverview
        status="success"
        {...successProps}
        active={{ ...active, window: "30d" }}
      />,
    );
    expect(
      screen.getByRole("heading", { name: "Monthly active installations" }),
    ).toBeDefined();
  });
});
