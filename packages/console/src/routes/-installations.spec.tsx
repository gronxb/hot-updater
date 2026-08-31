import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ComponentType, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  history: vi.fn(),
  events: vi.fn(),
  refreshEvents: vi.fn(),
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
  Link: ({
    children,
    className,
    to,
  }: {
    readonly children: ReactNode;
    readonly className?: string;
    readonly to: string;
  }) => (
    <a className={className} href={to}>
      {children}
    </a>
  ),
}));

vi.mock("@/components/BundleIdDisplay", () => ({
  BundleIdDisplay: ({ bundleId }: { bundleId: string }) => bundleId,
}));
vi.mock("@/components/features/insights/InsightsCapabilityContext", () => ({
  useInsightsCapability: () => ({
    status: "supported",
    mode: "bounded",
    maxMatchingRows: 50_000,
  }),
}));
vi.mock("@/components/ui/sidebar", () => ({
  SidebarTrigger: () => null,
}));
vi.mock("@/lib/insights-api", () => ({
  isInsightsQueryEnabled: () => true,
}));
vi.mock("@/lib/api", () => ({
  useEventHistoryQuery: mocks.events,
  useInstallationHistoryQuery: mocks.history,
  useInstallationSearchQuery: mocks.searchInstallations,
}));

import { Route } from "./installations";

const InstallationsPage = (
  Route as unknown as { readonly component: ComponentType }
).component;

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
            username: "ada",
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
    mocks.events.mockReturnValue({
      data: { data: [], pagination: { total: 0, limit: 50, offset: 0 } },
      error: null,
      isLoading: false,
      isFetching: false,
      refetch: mocks.refreshEvents,
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

  it("loads all event types without searching or selecting a cached installation", () => {
    mocks.search.mockReturnValue({ searchOffset: 0, historyOffset: 0 });
    mocks.events.mockReturnValue({
      data: {
        data: [
          "UPDATE_APPLIED",
          "RECOVERED",
          "RELEASE_ADOPTED",
          "UNCHANGED",
        ].map((type, index) => ({
          id: `event-${index}`,
          type,
          installId: `install-${index}`,
          fromBundleId: type === "UNCHANGED" ? null : "bundle-a",
          toBundleId: "bundle-b",
          userId: `user-${index}`,
          username: null,
          appVersion: "1.0.0",
          platform: "ios",
          channel: "production",
          receivedAtMs: Date.UTC(2026, 6, 18),
        })),
        pagination: { total: 54, limit: 50, offset: 0 },
      },
      error: null,
      isLoading: false,
      isFetching: false,
      refetch: mocks.refreshEvents,
    });
    render(<InstallationsPage />);

    expect(mocks.events).toHaveBeenCalledWith({ limit: 50, offset: 0 }, true);
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "All events" })).toBeDefined();
    for (const label of [
      "Bundle applied",
      "Recovered",
      "Release adopted",
      "Unchanged",
    ]) {
      expect(screen.getByText(label)).toBeDefined();
    }
    expect(
      screen.queryByRole("heading", { name: "Matching installations" }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: "/installations",
      search: {
        query: undefined,
        installId: undefined,
        searchOffset: 0,
        historyOffset: 50,
      },
      replace: false,
    });
  });

  it("returns from a filtered history to all events with pagination reset", () => {
    mocks.search.mockReturnValue({
      query: "user-1",
      installId: "install-1",
      searchOffset: 20,
      historyOffset: 50,
    });
    render(<InstallationsPage />);
    expect(mocks.events).toHaveBeenCalledWith({ limit: 50, offset: 50 }, false);
    fireEvent.click(screen.getByRole("button", { name: "View all events" }));
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: "/installations",
      search: {
        query: undefined,
        installId: undefined,
        searchOffset: 0,
        historyOffset: 0,
      },
      replace: false,
    });
  });

  it("provides a refresh action when no events have been recorded", () => {
    mocks.search.mockReturnValue({ searchOffset: 0, historyOffset: 0 });
    render(<InstallationsPage />);
    expect(screen.getByText("No events recorded yet")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Refresh events" }));
    expect(mocks.refreshEvents).toHaveBeenCalled();
  });

  it("provides a clear route back to Insights", () => {
    render(<InstallationsPage />);

    expect(
      screen
        .getByRole("link", { name: "Back to Insights" })
        .getAttribute("href"),
    ).toBe("/insights");
  });

  it("labels the history search for either a user ID or install ID", () => {
    render(<InstallationsPage />);

    expect(
      screen
        .getByRole("searchbox", { name: "User ID or install ID" })
        .getAttribute("placeholder"),
    ).toBe("Enter a user ID or install ID");
    expect(
      screen.getByRole<HTMLButtonElement>("button", {
        name: "Search history",
      }).disabled,
    ).toBe(false);
  });

  it("disables history search when the identifier is empty", () => {
    mocks.search.mockReturnValue({
      query: undefined,
      installId: undefined,
      searchOffset: 0,
      historyOffset: 0,
    });

    render(<InstallationsPage />);

    expect(
      screen.getByRole<HTMLButtonElement>("button", {
        name: "Search history",
      }).disabled,
    ).toBe(true);
  });

  it("exposes the selected installation to assistive technology", () => {
    mocks.search.mockReturnValue({
      query: "user-1",
      installId: "install-1",
      searchOffset: 0,
      historyOffset: 0,
    });

    render(<InstallationsPage />);

    expect(
      screen
        .getByRole("button", { name: /install-1/ })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("shows the user ID instead of an internal username", () => {
    render(<InstallationsPage />);

    expect(screen.getAllByText("user-1").length).toBeGreaterThan(0);
    expect(screen.queryByText("ada")).toBeNull();
  });
});
