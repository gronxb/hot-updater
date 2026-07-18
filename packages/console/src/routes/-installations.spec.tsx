import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  history: vi.fn(),
  navigate: vi.fn(),
  search: vi.fn(),
  searchInstallations: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({
    ...options,
    useNavigate: () => mocks.navigate,
    useSearch: mocks.search,
  }),
}));

vi.mock("@/components/BundleIdDisplay", () => ({
  BundleIdDisplay: ({ bundleId }: { bundleId: string }) => bundleId,
}));
vi.mock("@/components/features/analytics/AnalyticsCapabilityContext", () => ({
  useAnalyticsCapability: () => ({ status: "supported", mode: "dedicated" }),
}));
vi.mock("@/components/ui/sidebar", () => ({
  SidebarTrigger: () => null,
}));
vi.mock("@/lib/analytics-api", () => ({
  isAnalyticsQueryEnabled: () => true,
}));
vi.mock("@/lib/api", () => ({
  useInstallationHistoryQuery: mocks.history,
  useInstallationSearchQuery: mocks.searchInstallations,
}));

import { InstallationsPage } from "./installations";

describe("InstallationsPage", () => {
  beforeEach(() => {
    mocks.search.mockReturnValue({
      query: "user-1",
      installId: undefined,
      searchOffset: 0,
      historyOffset: 0,
    });
    mocks.searchInstallations.mockReturnValue({
      data: {
        data: [
          {
            installId: "install-1",
            username: null,
            userId: "user-1",
            lastKnownBundleId: "bundle-a",
            latestStatus: "UPDATE_APPLIED",
            platform: "ios",
            appVersion: "1.0.0",
            channel: "production",
            cohort: null,
            receivedAtMs: Date.UTC(2026, 6, 18),
          },
        ],
        pagination: { total: 1, limit: 20, offset: 0 },
      },
      error: null,
      isLoading: false,
    });
    mocks.history.mockReturnValue({
      data: undefined,
      error: null,
      isLoading: false,
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("opens the first matching history for a user or install ID query", async () => {
    render(<InstallationsPage />);

    await waitFor(() =>
      expect(mocks.navigate).toHaveBeenCalledWith({
        to: "/installations",
        search: {
          query: "user-1",
          installId: "install-1",
          searchOffset: 0,
          historyOffset: 0,
        },
        replace: true,
      }),
    );
  });
});
