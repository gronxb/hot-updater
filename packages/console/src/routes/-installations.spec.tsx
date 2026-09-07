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
  events: vi.fn(),
  history: vi.fn(),
  installation: vi.fn(),
  matches: vi.fn(),
  navigate: vi.fn(),
  search: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({
    ...options,
    useNavigate: () => mocks.navigate,
    useSearch: mocks.search,
  }),
  Link: ({
    children,
    to,
  }: {
    readonly children: ReactNode;
    readonly to: string;
  }) => <a href={to}>{children}</a>,
  useElementScrollRestoration: () => undefined,
}));

vi.mock("@/components/ui/sidebar", () => ({
  SidebarTrigger: () => null,
}));

vi.mock("@/lib/insights-api", () => ({
  useInsightsEventsQuery: mocks.events,
  useInsightsInstallationEventsQuery: mocks.history,
  useInsightsInstallationQuery: mocks.installation,
  useInsightsInstallationsQuery: mocks.matches,
}));

import { Route } from "./installations";

const InstallationsPage = (
  Route as unknown as { readonly component: ComponentType }
).component;

const installation = {
  appVersion: "1.4.2",
  channel: "production",
  cohort: "cohort-a",
  installId: "install-1",
  lastKnownBundleId: "bundle-b",
  latestStatus: "UPDATE_APPLIED" as const,
  platform: "ios" as const,
  receivedAtMs: Date.UTC(2026, 6, 18, 10),
  userId: "user-1",
  username: "ada",
};

const event = (
  type: "UPDATE_APPLIED" | "RECOVERED" | "UNCHANGED",
  id: string,
) => ({
  appVersion: "1.4.2",
  channel: "production",
  cohort: "cohort-a",
  fromBundleId: type === "UNCHANGED" ? null : "bundle-a",
  id,
  installId: `install-${id}`,
  platform: "ios" as const,
  receivedAtMs: Date.UTC(2026, 6, 18, 10),
  toBundleId: "bundle-b",
  type,
  userId: `user-${id}`,
  username: null,
});

describe("InstallationsPage", () => {
  beforeEach(() => {
    mocks.search.mockReturnValue({ eventsBefore: 100 });
    mocks.events.mockReturnValue({
      data: {
        beforeReceivedAtMs: 100,
        data: [
          event("UNCHANGED", "activity"),
          event("UPDATE_APPLIED", "applied"),
          event("RECOVERED", "recovered"),
        ],
        nextCursor: "next-events",
      },
      error: null,
      isFetching: false,
      isLoading: false,
    });
    mocks.matches.mockReturnValue({
      data: undefined,
      error: null,
      isLoading: false,
    });
    mocks.installation.mockReturnValue({
      data: undefined,
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

  it("opens on filter-free events and advances with an opaque cursor", () => {
    render(<InstallationsPage />);

    expect(mocks.events).toHaveBeenCalledWith(
      { beforeReceivedAtMs: 100, cursor: undefined, limit: 50 },
      true,
    );
    expect(screen.getByRole("heading", { name: "All events" })).toBeDefined();
    for (const label of ["Activity reported", "Bundle applied", "Recovered"]) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }

    fireEvent.click(
      within(
        screen.getByRole("navigation", {
          name: "All events pagination",
        }),
      ).getByRole("button", { name: "Next" }),
    );
    expect(mocks.navigate).toHaveBeenLastCalledWith({
      replace: true,
      search: {
        eventsBefore: 100,
        eventsCursor: "next-events",
      },
      to: "/installations",
    });
  });

  it("performs an exact identity lookup and selects its first installation", async () => {
    mocks.search.mockReturnValue({
      eventsBefore: 100,
      query: "user-1",
    });
    mocks.matches.mockReturnValue({
      data: {
        data: [installation, { ...installation, installId: "install-2" }],
        nextCursor: null,
      },
      error: null,
      isLoading: false,
    });

    render(<InstallationsPage />);

    expect(mocks.matches).toHaveBeenCalledWith(
      { cursor: undefined, identity: "user-1", limit: 20 },
      true,
    );
    expect(mocks.events).toHaveBeenCalledWith(expect.anything(), false);
    await waitFor(() =>
      expect(mocks.navigate).toHaveBeenCalledWith({
        replace: true,
        search: expect.objectContaining({
          eventsBefore: 100,
          historyCursor: undefined,
          installId: "install-1",
          query: "user-1",
        }),
        to: "/installations",
      }),
    );
  });

  it("pages the selected installation's movement history independently", () => {
    mocks.search.mockReturnValue({
      eventsBefore: 100,
      historyBefore: 200,
      installId: "install-1",
      query: "user-1",
    });
    mocks.matches.mockReturnValue({
      data: { data: [installation], nextCursor: null },
      error: null,
      isLoading: false,
    });
    mocks.installation.mockReturnValue({
      data: installation,
      error: null,
      isLoading: false,
    });
    mocks.history.mockReturnValue({
      data: {
        beforeReceivedAtMs: 200,
        data: [event("UPDATE_APPLIED", "movement")],
        nextCursor: "next-history",
      },
      error: null,
      isLoading: false,
    });

    render(<InstallationsPage />);

    expect(mocks.history).toHaveBeenCalledWith(
      {
        beforeReceivedAtMs: 200,
        cursor: undefined,
        installId: "install-1",
        limit: 50,
      },
      true,
    );
    fireEvent.click(
      within(
        screen.getByRole("navigation", {
          name: "Installation history pagination",
        }),
      ).getByRole("button", { name: "Next" }),
    );
    expect(mocks.navigate).toHaveBeenLastCalledWith({
      replace: true,
      search: {
        eventsBefore: 100,
        historyBefore: 200,
        historyCursor: "next-history",
        installId: "install-1",
        query: "user-1",
      },
      to: "/installations",
    });
  });
});
