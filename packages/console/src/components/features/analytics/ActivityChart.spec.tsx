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

  it("renders every bundle and non-cumulative bucket in an exact table", () => {
    const bucketStartMs = [
      Date.UTC(2026, 6, 15),
      Date.UTC(2026, 6, 16),
      Date.UTC(2026, 6, 17),
    ];
    const bundleSeries = [
      {
        bundleId: "bundle-a",
        series: bucketStartMs.map((value, index) => ({
          bucketStartMs: value,
          value: [2, 0, 1][index] ?? 0,
        })),
      },
      {
        bundleId: "bundle-b",
        series: bucketStartMs.map((value, index) => ({
          bucketStartMs: value,
          value: [0, 1, 1][index] ?? 0,
        })),
      },
    ];

    render(<ActivityChart bundleSeries={bundleSeries} window="7d" />);

    expect(
      screen
        .getByTestId("activity-chart-data")
        .getAttribute("data-accessibility-layer"),
    ).toBe("true");
    expect(
      screen.getByTestId("activity-chart-data").getAttribute("data-item-count"),
    ).toBe("3");
    const table = screen.getByRole("table", {
      name: "Exact reporting installations by bundle",
    });
    expect(table.parentElement?.classList.contains("sr-only")).toBe(true);
    expect(table.classList.contains("sr-only")).toBe(false);
    expect(within(table).getAllByRole("row")).toHaveLength(4);
    expect(
      within(table).getByRole("columnheader", { name: "bundle-a" }),
    ).toBeDefined();
    expect(
      within(table).getByRole("columnheader", { name: "bundle-b" }),
    ).toBeDefined();
    expect(within(table).getAllByRole("cell", { name: "0" })).toHaveLength(2);
    expect(
      screen.getByText(
        "Each time bucket counts an installation once under the bundle in its latest status report. Bucket counts reset and do not accumulate.",
      ),
    ).toBeDefined();
  });
});
