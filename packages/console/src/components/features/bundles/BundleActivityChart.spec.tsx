import { cleanup, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BundleActivityChart } from "./BundleActivityChart";

vi.mock("recharts", () => ({
  Area: () => null,
  AreaChart: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CartesianGrid: () => null,
  XAxis: () => null,
  YAxis: () => null,
}));

vi.mock("@/components/ui/chart", () => ({
  ChartContainer: ({
    children,
    config: _config,
    ...props
  }: React.ComponentProps<"div"> & { config: unknown }) => (
    <div {...props}>{children}</div>
  ),
  ChartTooltip: () => null,
  ChartTooltipContent: () => null,
}));

describe("BundleActivityChart", () => {
  afterEach(cleanup);

  it("keeps exact per-bucket values in a non-overflowing hidden wrapper", () => {
    render(
      <BundleActivityChart
        installed={[
          { bucketStartMs: Date.UTC(2026, 6, 16), value: 1 },
          { bucketStartMs: Date.UTC(2026, 6, 17), value: 3 },
        ]}
        recovered={[{ bucketStartMs: Date.UTC(2026, 6, 17), value: 1 }]}
        window="30d"
      />,
    );

    const table = screen.getByRole("table", {
      name: /Distinct bundle movement in each bucket over 30 days/i,
    });
    expect(table.parentElement?.classList.contains("sr-only")).toBe(true);
    expect(table.classList.contains("sr-only")).toBe(false);
    expect(within(table).getAllByRole("row")).toHaveLength(3);
  });
});
