import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { InsightsEventRow } from "@/lib/insights-view";

import { InstallationHistoryCard } from "./InstallationHistoryCard";

vi.mock("@/lib/insights-api", () => ({
  useDeleteInsightsDataMutation: () => ({
    isPending: false,
    mutateAsync: vi.fn(),
  }),
}));

const event: InsightsEventRow = {
  appVersion: "1.2.3",
  channel: "production",
  cohort: "1",
  fromBundleId: "bundle-old",
  id: "event-1",
  installId: "install-1",
  platform: "ios",
  receivedAtMs: Date.UTC(2026, 6, 18),
  toBundleId: "bundle-new",
  type: "UPDATE_APPLIED",
  userId: "user-1",
  username: null,
};

describe("InstallationHistoryCard", () => {
  afterEach(cleanup);

  it("shows downloaded and waiting without replacing the running bundle", () => {
    const downloaded = { ...event, type: "UPDATE_DOWNLOADED" as const };
    render(
      <InstallationHistoryCard
        error={null}
        history={{ data: [downloaded], nextCursor: null }}
        isLoading={false}
        onNext={vi.fn()}
        onPrevious={vi.fn()}
        pageNumber={1}
        selectedEvent={downloaded}
        selectedInstallId="install-1"
      />,
    );
    expect(screen.getByText("Downloaded · Pending apply")).toBeDefined();
    expect(screen.getAllByText("bundle-old").length).toBeGreaterThan(0);
    expect(screen.getAllByText("bundle-new").length).toBeGreaterThan(0);
  });

  it("shows latest identity and paged movement history", () => {
    const onNext = vi.fn();
    render(
      <InstallationHistoryCard
        error={null}
        history={{ data: [event], nextCursor: "next" }}
        isLoading={false}
        onNext={onNext}
        onPrevious={vi.fn()}
        pageNumber={1}
        selectedEvent={event}
        selectedInstallId="install-1"
      />,
    );

    expect(screen.getByText("user-1")).toBeDefined();
    expect(screen.getAllByText("Update applied").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(onNext).toHaveBeenCalledOnce();
  });

  it("explains an installation with no bundle movement", () => {
    render(
      <InstallationHistoryCard
        error={null}
        history={{ data: [], nextCursor: null }}
        isLoading={false}
        onNext={vi.fn()}
        onPrevious={vi.fn()}
        pageNumber={1}
        selectedEvent={undefined}
        selectedInstallId="install-1"
      />,
    );

    expect(screen.getByText("No bundle changes recorded yet.")).toBeDefined();
  });

  it("says an empty page after a full one has no older bundle changes", () => {
    render(
      <InstallationHistoryCard
        error={null}
        history={{ data: [], nextCursor: null }}
        isLoading={false}
        onNext={vi.fn()}
        onPrevious={vi.fn()}
        pageNumber={2}
        selectedEvent={event}
        selectedInstallId="install-1"
      />,
    );

    expect(screen.getByText("No older bundle changes.")).toBeDefined();
    expect(
      (screen.getByRole("button", { name: "Previous" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    expect(
      (screen.getByRole("button", { name: "Next" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("offers deletion only where the console deletes Insights data", () => {
    const card = (canDelete: boolean) => (
      <InstallationHistoryCard
        canDelete={canDelete}
        error={null}
        history={{ data: [event], nextCursor: null }}
        isLoading={false}
        onNext={vi.fn()}
        onPrevious={vi.fn()}
        pageNumber={1}
        selectedEvent={event}
        selectedInstallId="install-1"
      />
    );
    const { rerender } = render(card(false));
    expect(screen.queryByRole("button", { name: "Delete data" })).toBeNull();
    expect(screen.getByText(/kept for 90 days/)).toBeDefined();

    rerender(card(true));
    expect(screen.getByRole("button", { name: "Delete data" })).toBeDefined();
  });
});
