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

  it("renders every non-cumulative bucket, including zero, in an exact table", () => {
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
    const table = screen.getByRole("table", {
      name: "Exact active installation values",
    });
    expect(table.parentElement?.classList.contains("sr-only")).toBe(true);
    expect(table.classList.contains("sr-only")).toBe(false);
    expect(within(table).getAllByRole("row")).toHaveLength(4);
    expect(within(table).getByRole("cell", { name: "0" })).toBeDefined();
  });
});
