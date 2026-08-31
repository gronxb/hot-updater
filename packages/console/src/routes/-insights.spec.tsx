import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  active: vi.fn(),
  insights: vi.fn(),
  capability: vi.fn(),
  catalog: vi.fn(),
  controls: vi.fn(),
  overview: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({ options }),
  Link: ({
    children,
    to,
    ...props
  }: {
    children: ReactNode;
    to: string;
    "aria-current"?: "page";
  }) => (
    <a href={to} aria-current={props["aria-current"]}>
      {children}
    </a>
  ),
}));

vi.mock("@/components/features/insights/InsightsCapabilityContext", () => ({
  useInsightsCapability: mocks.capability,
}));
vi.mock("@/components/features/insights/InsightsControls", () => ({
  InsightsControls: (props: {
    onWindowChange: (window: "24h" | "7d" | "30d") => void;
  }) => {
    mocks.controls(props);
    return (
      <>
        <button onClick={() => props.onWindowChange("7d")}>
          Select window
        </button>
      </>
    );
  },
}));
vi.mock("@/components/features/insights/InsightsOverview", () => ({
  InsightsOverview: (props: {
    onBundleChange?: (bundleId: string) => void;
  }) => {
    mocks.overview(props);
    return (
      <div data-testid="insights-overview">
        <button onClick={() => props.onBundleChange?.("bundle-b")}>
          Select bundle
        </button>
      </div>
    );
  },
}));
vi.mock("@/components/ui/sidebar", () => ({
  SidebarTrigger: () => null,
}));
vi.mock("@/lib/insights-api", () => ({
  useActiveInstallationQuery: mocks.active,
  useInsightsOverviewQuery: mocks.catalog,
}));
vi.mock("@/lib/api", () => ({
  useBundleEventInsightsQuery: mocks.insights,
}));

import { Route } from "./insights";

const InsightsPage = Route.options.component;
if (!InsightsPage) throw new Error("Insights route component is required");

const activeData = {
  asOfMs: Date.UTC(2026, 6, 18),
  window: "30d",
  activeInstallations: 4,
  series: [],
  bundleSeries: [],
  bundles: [{ bundleId: "bundle-a", installations: 4 }],
};

const catalogData = {
  trackedInstallations: 4,
  mostCommonLatestReportedBundle: null,
  latestReportedBundles: [],
  configuredRollouts: [
    {
      bundleId: "bundle-a",
      configuredPercentage: 100,
      trackedInstallations: 4,
      bundle: {
        platform: "ios",
        channel: "production",
        targetAppVersion: "1.0.0",
        fingerprintHash: null,
      },
    },
    {
      bundleId: "bundle-b",
      configuredPercentage: 25,
      trackedInstallations: 0,
      bundle: {
        platform: "android",
        channel: "production",
        targetAppVersion: "1.0.0",
        fingerprintHash: null,
      },
    },
  ],
};

const insightsData = {
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

describe("InsightsPage", () => {
  beforeEach(() => {
    mocks.capability.mockReturnValue({
      status: "supported",
      mode: "bounded",
      maxMatchingRows: 50_000,
    });
    mocks.active.mockReturnValue({
      data: activeData,
      error: null,
      isLoading: false,
    });
    mocks.catalog.mockReturnValue({
      data: catalogData,
      error: null,
      isLoading: false,
    });
    mocks.insights.mockReturnValue({
      data: insightsData,
      error: null,
      isLoading: false,
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("requests insights for the selected bundle and reporting period", () => {
    const { container } = render(<InsightsPage />);

    expect(mocks.insights).toHaveBeenCalledWith(
      {
        bundleId: "bundle-a",
        window: "30d",
        limit: 1,
        offset: 0,
      },
      true,
    );
    expect(mocks.active).toHaveBeenCalledWith(expect.anything(), {
      window: "30d",
    });
    expect(mocks.overview).toHaveBeenCalledWith(
      expect.objectContaining({
        outcomes: {
          status: "success",
          bundleId: "bundle-a",
          data: insightsData,
        },
      }),
    );
    expect(container.querySelector("main")).toBeNull();
    expect(
      screen.getByText(
        "This database scans up to 50,000 event records per query.",
      ),
    ).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Select bundle" }));
    fireEvent.click(screen.getByRole("button", { name: "Select window" }));

    expect(mocks.insights).toHaveBeenLastCalledWith(
      {
        bundleId: "bundle-b",
        window: "7d",
        limit: 1,
        offset: 0,
      },
      true,
    );
    expect(mocks.active).toHaveBeenLastCalledWith(expect.anything(), {
      window: "7d",
    });
  });

  it("shows Overview as the current view and a direct Events destination", () => {
    render(<InsightsPage />);
    expect(
      screen
        .getByRole("link", { name: "Overview" })
        .getAttribute("aria-current"),
    ).toBe("page");
    expect(
      screen.getByRole("link", { name: "Events" }).getAttribute("href"),
    ).toBe("/installations");
    expect(screen.queryByRole("searchbox")).toBeNull();
  });
});
