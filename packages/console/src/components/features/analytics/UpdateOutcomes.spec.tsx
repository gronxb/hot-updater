import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { UpdateOutcomes } from "./UpdateOutcomes";

vi.mock("../bundles/BundleActivityChart", () => ({
  BundleActivityChart: ({
    installed,
    recovered,
  }: {
    installed: readonly unknown[];
    recovered: readonly unknown[];
  }) => (
    <div
      data-installed-points={installed.length}
      data-recovered-points={recovered.length}
      data-testid="outcome-activity-chart"
    />
  ),
}));

const analytics = {
  summary: { installed: 8, recovered: 2 },
  series: {
    installed: [
      { bucketStartMs: Date.UTC(2026, 6, 16), value: 5 },
      { bucketStartMs: Date.UTC(2026, 6, 17), value: 8 },
    ],
    recovered: [{ bucketStartMs: Date.UTC(2026, 6, 17), value: 2 }],
  },
  cohorts: { installed: [], recovered: [] },
  recentEvents: {
    data: [],
    pagination: { total: 0, limit: 1, offset: 0 },
  },
};

describe("UpdateOutcomes", () => {
  afterEach(cleanup);

  it("renders all-time outcomes and both 30-day cumulative series", () => {
    render(
      <UpdateOutcomes
        state={{ status: "success", bundleId: "bundle-a", data: analytics }}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Update outcomes" }),
    ).toBeDefined();
    expect(screen.getByText("Applied on")).toBeDefined();
    expect(screen.getByText("Recovered from")).toBeDefined();
    expect(screen.getByText("8")).toBeDefined();
    expect(screen.getByText("2")).toBeDefined();
    const chart = screen.getByTestId("outcome-activity-chart");
    expect(chart.getAttribute("data-installed-points")).toBe("2");
    expect(chart.getAttribute("data-recovered-points")).toBe("1");
  });
});
