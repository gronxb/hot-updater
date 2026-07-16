import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BundleAdoption } from "@/lib/analytics-overview";

import { AdoptionChart } from "./AdoptionChart";

vi.mock("recharts", () => ({
  Bar: () => null,
  BarChart: ({
    accessibilityLayer,
    children,
  }: {
    readonly accessibilityLayer?: boolean;
    readonly children: React.ReactNode;
  }) => (
    <div
      data-accessibility-layer={accessibilityLayer}
      data-testid="adoption-bar-chart"
    >
      {children}
    </div>
  ),
  CartesianGrid: () => null,
  XAxis: ({
    domain,
    ticks,
  }: {
    readonly domain: readonly number[];
    readonly ticks: readonly number[];
  }) => (
    <div
      data-domain={domain.join(",")}
      data-testid="adoption-count-axis"
      data-ticks={ticks.join(",")}
    />
  ),
  YAxis: () => null,
}));

vi.mock("@/components/ui/chart", () => ({
  ChartContainer: ({
    "aria-label": ariaLabel,
    children,
  }: {
    readonly "aria-label"?: string;
    readonly children: React.ReactNode;
  }) => <div aria-label={ariaLabel}>{children}</div>,
  ChartTooltip: () => null,
  ChartTooltipContent: () => null,
}));

const adoptionItem: BundleAdoption = {
  bundleId: "bundle-a",
  trackedInstallations: 1,
  observedShare: 1,
  bundle: {
    platform: "ios",
    channel: "production",
    targetAppVersion: "1.0.0",
    fingerprintHash: null,
  },
};

describe("AdoptionChart", () => {
  afterEach(cleanup);

  it("uses an exact zero-to-one axis for one observed installation", () => {
    // Given
    const adoption = [adoptionItem];

    // When
    render(<AdoptionChart adoption={adoption} />);

    // Then
    const axis = screen.getByTestId("adoption-count-axis");
    expect(axis.getAttribute("data-domain")).toBe("0,1");
    expect(axis.getAttribute("data-ticks")).toBe("0,1");
    expect(screen.getByLabelText("Observed bundle adoption")).toBeDefined();
    expect(
      screen
        .getByTestId("adoption-bar-chart")
        .getAttribute("data-accessibility-layer"),
    ).toBe("true");
  });

  it("keeps a larger adoption axis bounded to the observed maximum", () => {
    // Given
    const adoption = [
      {
        ...adoptionItem,
        trackedInstallations: 1250,
      },
    ];

    // When
    render(<AdoptionChart adoption={adoption} />);

    // Then
    const axis = screen.getByTestId("adoption-count-axis");
    expect(axis.getAttribute("data-domain")).toBe("0,1250");
    expect(axis.getAttribute("data-ticks")).toBe("0,313,626,939,1250");
  });
});
