import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  active: vi.fn(),
  insights: vi.fn(),
  capability: vi.fn(),
  catalog: vi.fn(),
  controls: vi.fn(),
  navigate: vi.fn(),
  overview: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({ options }),
  useNavigate: () => mocks.navigate,
}));

vi.mock("@/components/features/insights/InsightsCapabilityContext", () => ({
  useInsightsCapability: mocks.capability,
}));
vi.mock("@/components/features/insights/InsightsControls", () => ({
  InsightsControls: (props: {
    onInstallationSearch: (query: string) => void;
    onWindowChange: (window: "24h" | "7d" | "30d") => void;
  }) => {
    mocks.controls(props);
    return (
      <>
        <button onClick={() => props.onInstallationSearch("user-1")}>
          Search installation history
        </button>
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
        "This database scans up to 50,000 matching insights records per query.",
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

  it("opens matching installation history from one user or install ID", () => {
    render(<InsightsPage />);

    fireEvent.click(
      screen.getByRole("button", { name: "Search installation history" }),
    );

    expect(mocks.navigate).toHaveBeenCalledWith({
      to: "/installations",
      search: {
        query: "user-1",
        installId: undefined,
        searchOffset: 0,
        historyOffset: 0,
      },
    });
  });
});
