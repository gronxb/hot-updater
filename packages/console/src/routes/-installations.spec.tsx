import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ComponentType, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  history: vi.fn(),
  scrollEntry: vi.fn(),
  events: vi.fn(),
  refreshEvents: vi.fn(),
  navigate: vi.fn(),
  search: vi.fn(),
  searchInstallations: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  useElementScrollRestoration: mocks.scrollEntry,
  createFileRoute: () => (options: Record<string, unknown>) => ({
    ...options,
    useNavigate: () => mocks.navigate,
    useSearch: mocks.search,
  }),
  Link: ({
    children,
    className,
    to,
    search,
    ...props
  }: {
    readonly children: ReactNode;
    readonly className?: string;
    readonly to: string;
    readonly search?: Record<string, string | number | undefined>;
    readonly "aria-current"?: "page";
    readonly "aria-label"?: string;
  }) => (
    <a
      className={className}
      href={`${to}${
        search
          ? `?${new URLSearchParams(
              Object.entries(search)
                .filter(([, value]) => value !== undefined)
                .map(([key, value]) => [key, String(value)]),
            )}`
          : ""
      }`}
      aria-current={props["aria-current"]}
      aria-label={props["aria-label"]}
    >
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
    mocks.scrollEntry.mockReturnValue(undefined);
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
          eventsOffset: undefined,
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
    expect(screen.getByRole("heading", { name: /All events/ })).toBeDefined();
    for (const label of [
      "Bundle applied",
      "Recovered",
      "Bundle adopted",
      "Activity reported",
    ]) {
      expect(within(screen.getByRole("table")).getByText(label)).toBeDefined();
      expect(
        within(screen.getByRole("list", { name: "Events" })).getByText(label),
      ).toBeDefined();
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
        eventsOffset: undefined,
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
    fireEvent.click(screen.getByRole("button", { name: "Back to all events" }));
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: "/installations",
      search: {
        query: undefined,
        installId: undefined,
        searchOffset: 0,
        historyOffset: 0,
        eventsOffset: undefined,
      },
      replace: false,
    });
  });

  it("opens a trimmed installation lookup and remembers the event page", () => {
    mocks.search.mockReturnValue({ searchOffset: 0, historyOffset: 50 });
    render(<InstallationsPage />);
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "  install-1  " },
    });
    fireEvent.submit(screen.getByRole("search", { name: "Find installation" }));
    expect(mocks.navigate).toHaveBeenLastCalledWith({
      to: "/installations",
      search: {
        query: "install-1",
        installId: undefined,
        searchOffset: 0,
        historyOffset: 0,
        eventsOffset: 50,
      },
      replace: false,
    });
  });

  it("returns to the source event page after paging through installation history", () => {
    mocks.search.mockReturnValue({
      query: "install-1",
      installId: "install-1",
      searchOffset: 0,
      historyOffset: 100,
      eventsOffset: 50,
    });
    render(<InstallationsPage />);
    fireEvent.click(screen.getByRole("button", { name: "Back to all events" }));
    expect(mocks.navigate).toHaveBeenLastCalledWith({
      to: "/installations",
      search: {
        query: undefined,
        installId: undefined,
        searchOffset: 0,
        historyOffset: 50,
        eventsOffset: undefined,
      },
      replace: false,
    });
  });

  it("keeps lookup available while events load and offers a retry after an error", () => {
    mocks.search.mockReturnValue({ searchOffset: 0, historyOffset: 0 });
    mocks.events.mockReturnValue({ isLoading: true, isFetching: true });
    const { rerender } = render(<InstallationsPage />);
    expect(
      screen.getByRole("status", { name: "Loading events" }),
    ).toBeDefined();
    expect(screen.getByRole("searchbox")).toBeDefined();
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Refresh" })
        .disabled,
    ).toBe(true);

    mocks.events.mockReturnValue({
      isLoading: false,
      isFetching: false,
      error: new Error("Connection lost"),
      refetch: mocks.refreshEvents,
    });
    rerender(<InstallationsPage />);
    expect(screen.getByRole("alert")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(mocks.refreshEvents).toHaveBeenCalledOnce();
  });

  it("uses the browser time zone, preserves seconds, and keeps UTC details and full IDs", () => {
    vi.stubEnv("TZ", "America/New_York");
    mocks.search.mockReturnValue({ searchOffset: 0, historyOffset: 0 });
    mocks.events.mockReturnValue({
      data: {
        data: [
          Date.UTC(2026, 6, 18, 10, 2, 3),
          Date.UTC(2026, 0, 18, 10, 2, 3),
        ].map((receivedAtMs, index) => ({
          id: `event-${index}`,
          type: "UNCHANGED",
          installId: "019f635d-0007-7000-8000-000000000007",
          fromBundleId: null,
          toBundleId: "01972030-1aa1-7445-8b8c-121212121212",
          userId: "user-readable",
          username: null,
          appVersion: "1.4.2",
          platform: "ios",
          channel: "production",
          receivedAtMs,
        })),
        pagination: { total: 2, limit: 50, offset: 0 },
      },
      isLoading: false,
      isFetching: false,
      error: null,
    });
    try {
      render(<InstallationsPage />);
      const desktop = within(screen.getByRole("table"));
      expect(screen.getByRole("columnheader", { name: "Time" })).toBeDefined();
      expect(desktop.getByText("2026/07/18 06:02:03 GMT-4")).toBeDefined();
      expect(desktop.getByText("2026/01/18 05:02:03 GMT-5")).toBeDefined();
      const time = desktop.getByText("2026/07/18 06:02:03 GMT-4");
      expect(time.getAttribute("datetime")).toBe("2026-07-18T10:02:03.000Z");
      fireEvent.click(time.closest("summary")!);
      expect(time.closest("details")?.open).toBe(true);
      expect(desktop.getByText("2026-07-18 10:02:03.000 UTC")).toBeDefined();
      expect(
        desktop.getAllByRole("button", {
          name: "Copy full value: 01972030-1aa1-7445-8b8c-121212121212",
        }),
      ).toHaveLength(2);
      expect(desktop.getAllByText("01972030…1212")).toHaveLength(2);
      expect(screen.queryByText("From")).toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("explains the all-event query limit without promising lookup bypasses it", () => {
    mocks.search.mockReturnValue({ searchOffset: 0, historyOffset: 0 });
    mocks.events.mockReturnValue({
      isLoading: false,
      isFetching: false,
      error: new Error("Bundle event scan exceeded 50000 rows."),
    });
    render(<InstallationsPage />);
    expect(screen.getByText("Insights report limit reached")).toBeDefined();
    expect(screen.getByText(/The data is still stored/)).toBeDefined();
    expect(screen.getByRole("searchbox")).toBeDefined();
  });

  it("keeps identity navigation, full ID copying, and exact time available in the compact event list", async () => {
    const installId = "019f635d-0007-7000-8000-000000000007";
    const bundleId = "01972030-1aa1-7445-8b8c-121212121212";
    const writeText = vi.fn().mockResolvedValue(undefined);
    const originalClipboard = Object.getOwnPropertyDescriptor(
      navigator,
      "clipboard",
    );
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    mocks.search.mockReturnValue({ searchOffset: 0, historyOffset: 50 });
    mocks.events.mockReturnValue({
      data: {
        data: [
          {
            id: "event-activity",
            type: "UNCHANGED",
            installId,
            fromBundleId: null,
            toBundleId: bundleId,
            userId: "customer-with-a-long-readable-identifier",
            username: null,
            appVersion: "1.4.2",
            platform: "ios",
            channel: "production",
            receivedAtMs: Date.UTC(2026, 6, 18, 10, 2, 3),
          },
        ],
        pagination: { total: 51, limit: 50, offset: 50 },
      },
      error: null,
      isLoading: false,
      isFetching: false,
    });
    try {
      render(<InstallationsPage />);
      const list = within(screen.getByRole("list", { name: "Events" }));
      expect(list.getByText("Activity reported")).toBeDefined();
      expect(list.getByText("iOS 1.4.2")).toBeDefined();
      expect(list.getByText("production")).toBeDefined();
      expect(list.getByText("Current")).toBeDefined();
      expect(list.queryByText("From")).toBeNull();
      const link = list.getByRole("link", {
        name: /View history for customer/,
      });
      const destination = new URL(
        link.getAttribute("href")!,
        "http://localhost",
      );
      expect(destination.searchParams.get("installId")).toBe(installId);
      expect(destination.searchParams.get("eventsOffset")).toBe("50");
      const timestamp = list.getByText(/2026\/07\/18/);
      fireEvent.click(timestamp.closest("summary")!);
      expect(timestamp.closest("details")?.open).toBe(true);
      expect(list.getByText("2026-07-18 10:02:03.000 UTC")).toBeDefined();
      fireEvent.click(
        list.getByRole("button", { name: `Copy full value: ${installId}` }),
      );
      fireEvent.click(
        list.getByRole("button", { name: `Copy full value: ${bundleId}` }),
      );
      await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2));
      expect(writeText).toHaveBeenNthCalledWith(1, installId);
      expect(writeText).toHaveBeenNthCalledWith(2, bundleId);
      expect(mocks.navigate).not.toHaveBeenCalled();
    } finally {
      if (originalClipboard) {
        Object.defineProperty(navigator, "clipboard", originalClipboard);
      } else {
        Reflect.deleteProperty(navigator, "clipboard");
      }
    }
  });

  it("restores the source scroll position after event data finishes loading", () => {
    mocks.search.mockReturnValue({ searchOffset: 0, historyOffset: 50 });
    mocks.scrollEntry.mockReturnValue({ scrollX: 0, scrollY: 320 });
    mocks.events.mockReturnValue({ isLoading: true, isFetching: true });
    const { container, rerender } = render(<InstallationsPage />);
    expect(container.querySelector("#insights-events-scroll")?.scrollTop).toBe(
      0,
    );
    mocks.events.mockReturnValue({
      isLoading: false,
      isFetching: false,
      data: { data: [], pagination: { total: 0, offset: 50, limit: 50 } },
    });
    rerender(<InstallationsPage />);
    expect(container.querySelector("#insights-events-scroll")?.scrollTop).toBe(
      320,
    );
  });

  it("provides a refresh action when no events have been recorded", () => {
    mocks.search.mockReturnValue({ searchOffset: 0, historyOffset: 0 });
    render(<InstallationsPage />);
    expect(screen.getByText("No events recorded yet")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(mocks.refreshEvents).toHaveBeenCalled();
  });

  it("provides a clear route back to Insights", () => {
    render(<InstallationsPage />);

    expect(
      screen.getByRole("link", { name: "Overview" }).getAttribute("href"),
    ).toBe("/insights");
    expect(
      screen.getByRole("link", { name: "Events" }).getAttribute("aria-current"),
    ).toBe("page");
  });

  it("labels the history search for either a user ID or install ID", () => {
    render(<InstallationsPage />);

    expect(
      screen
        .getByRole("searchbox", { name: "User ID or install ID" })
        .getAttribute("placeholder"),
    ).toBe("User ID or install ID");
    expect(
      screen.getByRole<HTMLButtonElement>("button", {
        name: "Find installation",
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
        name: "Find installation",
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
        .getByRole("button", { name: "user-1, install ID install-1" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("shows the user ID instead of an internal username", () => {
    render(<InstallationsPage />);

    expect(screen.getAllByText("user-1").length).toBeGreaterThan(0);
    expect(screen.queryByText("ada")).toBeNull();
  });
});
