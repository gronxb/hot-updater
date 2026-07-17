import type { ActiveInstallationOverview } from "@hot-updater/plugin-core";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AnalyticsOverview } from "@/lib/analytics-overview";

import { BundleDistribution } from "./BundleDistribution";

vi.mock("recharts", () => ({
  Bar: () => null,
  BarChart: ({
    accessibilityLayer,
    children,
    data,
    layout,
  }: {
    accessibilityLayer?: boolean;
    children: ReactNode;
    data: readonly { label: string }[];
    layout?: string;
  }) => (
    <div
      data-accessibility-layer={accessibilityLayer}
      data-item-count={data.length}
      data-labels={data.map(({ label }) => label).join("|")}
      data-layout={layout}
      data-testid="bundle-distribution-chart-data"
    >
      {children}
    </div>
  ),
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
  ChartTooltip: ({ content }: { content: ReactNode }) => content,
  ChartTooltipContent: ({
    className,
    labelClassName,
  }: {
    className?: string;
    labelClassName?: string;
  }) => (
    <div
      data-class-name={className}
      data-label-class-name={labelClassName}
      data-testid="bundle-distribution-tooltip-content"
    />
  ),
}));

describe("BundleDistribution", () => {
  afterEach(cleanup);

  it("shows counts and shares whose rows sum to the active total", () => {
    const active: ActiveInstallationOverview = {
      asOfMs: Date.UTC(2026, 6, 18),
      window: "7d",
      activeInstallations: 4,
      series: [],
      bundles: [
        {
          bundleId: "01972030-1aa1-7445-8b8c-121212121212",
          installations: 3,
        },
        { bundleId: "unknown", installations: 1 },
      ],
    };
    const catalog: AnalyticsOverview = {
      trackedInstallations: 4,
      mostActiveBundle: null,
      adoption: [],
      configuredRollouts: [
        {
          bundleId: "01972030-1aa1-7445-8b8c-121212121212",
          configuredPercentage: 100,
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

    render(<BundleDistribution active={active} catalog={catalog} />);

    expect(
      screen.getByRole("img", {
        name: "Latest reported bundle distribution chart",
      }),
    ).toBeDefined();
    expect(
      screen
        .getByTestId("bundle-distribution-chart-data")
        .getAttribute("data-accessibility-layer"),
    ).toBe("true");
    expect(
      screen
        .getByTestId("bundle-distribution-chart-data")
        .getAttribute("data-layout"),
    ).toBe("vertical");
    expect(
      screen
        .getByTestId("bundle-distribution-chart-data")
        .getAttribute("data-labels"),
    ).toBe("01972030…21212|unknown");
    expect(
      screen
        .getByTestId("bundle-distribution-tooltip-content")
        .getAttribute("data-class-name"),
    ).toBe("max-w-52 sm:max-w-none");
    expect(
      screen
        .getByTestId("bundle-distribution-tooltip-content")
        .getAttribute("data-label-class-name"),
    ).toBe("break-all");
    const table = screen.getByRole("table", {
      name: "Latest reported bundle distribution",
    });
    expect(within(table).getByText("3")).toBeDefined();
    expect(within(table).getByText("75%")).toBeDefined();
    expect(within(table).getByText("1")).toBeDefined();
    expect(within(table).getByText("25%")).toBeDefined();
    expect(within(table).getByText("Unknown bundle metadata")).toBeDefined();
  });
});
