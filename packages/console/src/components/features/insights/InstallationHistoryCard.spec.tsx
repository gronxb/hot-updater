import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { InstallationHistoryCard } from "./InstallationHistoryCard";

describe("InstallationHistoryCard", () => {
  afterEach(cleanup);

  it("shows the app version reported with each history event", () => {
    // Given
    const history = {
      data: [
        {
          id: "event-a",
          type: "UPDATE_APPLIED" as const,
          fromBundleId: "bundle-a",
          toBundleId: "bundle-b",
          username: null,
          userId: "user-a",
          platform: "ios" as const,
          appVersion: "2.4.1",
          channel: "production",
          cohort: "cohort-a",
          receivedAtMs: Date.UTC(2026, 6, 18),
        },
      ],
      pagination: { total: 1, limit: 25, offset: 0 },
    };

    // When
    render(
      <InstallationHistoryCard
        error={null}
        history={history}
        isLoading={false}
        limit={25}
        offset={0}
        onOffsetChange={vi.fn()}
        selectedEvent={history.data[0]}
        selectedInstallId="install-a"
      />,
    );

    // Then
    const table = screen.getByRole("table");
    expect(
      within(table).getByRole("columnheader", { name: "App" }),
    ).toBeDefined();
    expect(within(table).getByText("iOS 2.4.1")).toBeDefined();
  });
  it("keeps the latest reported identity visible when no bundle changes exist", () => {
    const refresh = vi.fn();
    render(
      <InstallationHistoryCard
        error={null}
        history={{ data: [], pagination: { total: 0, limit: 50, offset: 0 } }}
        isLoading={false}
        limit={50}
        offset={0}
        onOffsetChange={vi.fn()}
        onRefresh={refresh}
        selectedInstallId="install-activity-only"
        selectedEvent={{
          installId: "install-activity-only",
          userId: "user-a",
          username: null,
          lastKnownBundleId: "bundle-a",
          latestStatus: "UNCHANGED",
          platform: "ios",
          appVersion: "1.0.0",
          channel: "production",
          cohort: "default",
          receivedAtMs: Date.UTC(2026, 6, 18),
        }}
      />,
    );
    expect(
      screen.getByRole("heading", { name: "Latest reported state" }),
    ).toBeDefined();
    expect(screen.getByText("user-a")).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Copy full value: bundle-a" }),
    ).toBeDefined();
    expect(screen.getByText(/No bundle changes recorded yet/)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("keeps refresh disabled while loading and offers a retry after a failure", () => {
    const refresh = vi.fn();
    const props = {
      error: null,
      history: undefined,
      isLoading: true,
      limit: 50,
      offset: 0,
      onOffsetChange: vi.fn(),
      onRefresh: refresh,
      selectedInstallId: "install-a",
      selectedEvent: undefined,
    };
    const { rerender } = render(<InstallationHistoryCard {...props} />);

    expect(
      screen.getByRole("status", { name: "Loading installation history" }),
    ).toBeDefined();
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Refresh" })
        .disabled,
    ).toBe(true);

    rerender(
      <InstallationHistoryCard
        {...props}
        error={new Error("Connection lost")}
        isLoading={false}
      />,
    );
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain(
      "Refresh to try again",
    );
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(refresh).toHaveBeenCalledOnce();
  });
});
