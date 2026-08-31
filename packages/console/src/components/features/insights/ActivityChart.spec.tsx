import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ActivityChart } from "./ActivityChart";

vi.mock("recharts", () => ({
  Area: () => null,
  AreaChart: ({
    accessibilityLayer,
    children,
    data,
  }: {
    accessibilityLayer?: boolean;
    children: React.ReactNode;
    data: readonly unknown[];
  }) => (
    <div
      data-accessibility-layer={accessibilityLayer}
      data-item-count={data.length}
      data-testid="activity-chart-data"
    >
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

describe("ActivityChart", () => {
  afterEach(cleanup);

  it("renders the aggregate activity series and its exact values", () => {
    const series = [
      { bucketStartMs: Date.UTC(2026, 6, 15), value: 2 },
      { bucketStartMs: Date.UTC(2026, 6, 16), value: 0 },
      { bucketStartMs: Date.UTC(2026, 6, 17), value: 1 },
    ];

    render(<ActivityChart series={series} window="7d" />);

    expect(
      screen
        .getByTestId("activity-chart-data")
        .getAttribute("data-accessibility-layer"),
    ).toBe("true");
    expect(
      screen.getByTestId("activity-chart-data").getAttribute("data-item-count"),
    ).toBe("3");
    expect(
      screen.getByText("Unique active installations per day"),
    ).toBeDefined();
    const table = screen.getByRole("table", {
      name: "Exact active installations per day",
    });
    expect(table.parentElement?.classList.contains("sr-only")).toBe(true);
    expect(within(table).getAllByRole("row")).toHaveLength(4);
    expect(
      within(table).getByRole("columnheader", {
        name: "Active installations",
      }),
    ).toBeDefined();
    expect(within(table).getByRole("cell", { name: "0" })).toBeDefined();
    expect(
      screen.getByText(
        "Each point counts an installation once in that day. The total above counts it once across the whole period, so the points do not add up to the total.",
      ),
    ).toBeDefined();
  });

  it("uses hourly language for the 24-hour window", () => {
    render(<ActivityChart series={[]} window="24h" />);

    expect(
      screen.getByText("Unique active installations per hour"),
    ).toBeDefined();
    expect(
      screen.getByText("No installations reported during this period."),
    ).toBeDefined();
  });
});
