import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BundleInsightsSummary } from "./BundleInsightsSummary";

const reportQuery = vi.fn();
const pageQuery = vi.fn();

vi.mock("@/lib/insights-api", () => ({
  useInsightsReportQuery: (input: unknown) => reportQuery(input),
  useInsightsReportPageQuery: (input: unknown, enabled: boolean) =>
    pageQuery(input, enabled),
}));

vi.mock("@/components/ui/chart", () => ({
  ChartContainer: ({ children, ...props }: { children: ReactNode }) => (
    <div data-testid="activity-chart" {...props}>
      {children}
    </div>
  ),
  ChartTooltip: () => null,
  ChartTooltipContent: () => null,
  ChartLegend: () => null,
  ChartLegendContent: () => null,
}));

vi.mock("recharts", () => ({
  Area: () => null,
  AreaChart: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CartesianGrid: () => null,
  XAxis: () => null,
  YAxis: () => null,
}));

const publication = {
  id: "00000000-0000-7000-8000-000000000001",
  kind: "bundleDetail" as const,
  asOfMs: Date.UTC(2026, 6, 18),
  completedAtMs: Date.UTC(2026, 6, 18),
  sourceGeneration: "source-1",
  accuracy: "exact" as const,
  summary: { installed: 2, recovered: 1 },
};

const page = (metric: "installed" | "recovered") => ({
  data: {
    state: "ready",
    data: {
      section: "movementSeries",
      metric,
      data: [
        {
          bucketStartMs: Date.UTC(2026, 6, 17),
          value: metric === "installed" ? 2 : 1,
        },
      ],
      nextCursor: null,
      hasNext: false,
      consistency: {
        kind: "snapshot",
        cutoff: { kind: "publication", publication },
      },
      total: { state: "exact", value: 1, sourceGeneration: "source-1" },
    },
  },
  error: null,
  isLoading: false,
});

describe("BundleInsightsSummary", () => {
  beforeEach(() => {
    reportQuery.mockReset();
    pageQuery.mockReset();
  });
  afterEach(cleanup);

  it("renders exact movement metrics from the published report", () => {
    reportQuery.mockReturnValue({
      data: { state: "ready", data: publication },
      error: null,
      isLoading: false,
    });
    pageQuery.mockImplementation(
      (input: { metric: "installed" | "recovered" }) => page(input.metric),
    );

    render(
      <BundleInsightsSummary bundleId="01972020-1aa1-7445-8b8c-111111111111" />,
    );

    expect(screen.getByText("Activity · 30 days")).toBeDefined();
    const applied = screen
      .getAllByText("Applied")
      .find(({ tagName }) => tagName === "DT");
    const recovered = screen
      .getAllByText("Recovered")
      .find(({ tagName }) => tagName === "DT");
    expect(applied?.nextElementSibling?.textContent).toBe("2");
    expect(recovered?.nextElementSibling?.textContent).toBe("1");
    expect(
      screen.getByRole("img", { name: "Bundle movement over 30 days" }),
    ).toBeDefined();
  });

  it("shows report preparation instead of an empty metric", () => {
    reportQuery.mockReturnValue({
      data: {
        state: "preparing",
        job: { id: "report-1" },
        versions: {
          schemaVersion: "1",
          storageVersion: "1",
          projectionGeneration: null,
          sourceGeneration: "source-1",
        },
      },
      error: null,
      isLoading: false,
    });
    pageQuery.mockReturnValue({
      data: undefined,
      error: null,
      isLoading: false,
    });

    render(
      <BundleInsightsSummary bundleId="01972020-1aa1-7445-8b8c-111111111111" />,
    );
    expect(screen.getByText("Preparing bundle activity")).toBeDefined();
  });
});
