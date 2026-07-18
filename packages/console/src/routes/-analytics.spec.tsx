import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentType } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  active: vi.fn(),
  analytics: vi.fn(),
  capability: vi.fn(),
  catalog: vi.fn(),
  controls: vi.fn(),
  navigate: vi.fn(),
  overview: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => options,
  useNavigate: () => mocks.navigate,
}));

vi.mock("@/components/features/analytics/AnalyticsCapabilityContext", () => ({
  useAnalyticsCapability: mocks.capability,
}));
vi.mock("@/components/features/analytics/AnalyticsControls", () => ({
  AnalyticsControls: (props: {
    onInstallationSearch: (query: string) => void;
    onBundleChange: (bundleId: string) => void;
    onWindowChange: (window: "24h" | "7d" | "30d") => void;
  }) => {
    mocks.controls(props);
    return (
      <>
        <button onClick={() => props.onInstallationSearch("user-1")}>
          Search installation history
        </button>
        <button onClick={() => props.onBundleChange("bundle-b")}>
          Select bundle
        </button>
        <button onClick={() => props.onWindowChange("7d")}>
          Select window
        </button>
      </>
    );
  },
}));
vi.mock("@/components/features/analytics/AnalyticsOverview", () => ({
  AnalyticsOverview: (props: unknown) => {
    mocks.overview(props);
    return <div data-testid="analytics-overview" />;
  },
}));
vi.mock("@/components/ui/sidebar", () => ({
  SidebarTrigger: () => null,
}));
vi.mock("@/lib/analytics-api", () => ({
  useActiveInstallationQuery: mocks.active,
  useAnalyticsOverviewQuery: mocks.catalog,
}));
vi.mock("@/lib/api", () => ({
  useBundleEventAnalyticsQuery: mocks.analytics,
}));

import { Route } from "./analytics";

const AnalyticsPage = (
  Route as unknown as { readonly component: ComponentType }
).component;

const activeData = {
  asOfMs: Date.UTC(2026, 6, 18),
  window: "30d",
  activeInstallations: 4,
  series: [],
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

const analyticsData = {
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

describe("AnalyticsPage", () => {
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
    mocks.analytics.mockReturnValue({
      data: analyticsData,
      error: null,
      isLoading: false,
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("requests analytics for the selected bundle and reporting period", () => {
    const { container } = render(<AnalyticsPage />);

    expect(mocks.analytics).toHaveBeenCalledWith(
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
          data: analyticsData,
        },
      }),
    );
    expect(container.querySelector("main")).toBeNull();
    expect(
      screen.getByText(
        "This database scans up to 50,000 matching analytics records per query.",
      ),
    ).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Select bundle" }));
    fireEvent.click(screen.getByRole("button", { name: "Select window" }));

    expect(mocks.analytics).toHaveBeenLastCalledWith(
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
    render(<AnalyticsPage />);

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
