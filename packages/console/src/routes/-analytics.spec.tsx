import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  active: vi.fn(),
  analytics: vi.fn(),
  capability: vi.fn(),
  catalog: vi.fn(),
  overview: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => options,
}));

vi.mock("@/components/features/analytics/AnalyticsCapabilityContext", () => ({
  useAnalyticsCapability: mocks.capability,
}));
vi.mock("@/components/features/analytics/AnalyticsControls", () => ({
  AnalyticsControls: () => null,
}));
vi.mock("@/components/features/analytics/AnalyticsOverview", () => ({
  AnalyticsOverview: (props: unknown) => {
    mocks.overview(props);
    return <div data-testid="analytics-overview" />;
  },
}));
vi.mock("@/components/features/analytics/InstallationSearch", () => ({
  InstallationSearch: () => null,
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

import { AnalyticsPage } from "./analytics";

const activeData = {
  asOfMs: Date.UTC(2026, 6, 18),
  window: "30d",
  activeInstallations: 4,
  series: [],
  bundles: [{ bundleId: "bundle-a", installations: 4 }],
};

const catalogData = {
  trackedInstallations: 4,
  mostActiveBundle: null,
  adoption: [],
  configuredRollouts: [],
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
    mocks.capability.mockReturnValue({ status: "supported" });
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

  it("requests 30-day analytics for the leading latest reported bundle", () => {
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
  });
});
