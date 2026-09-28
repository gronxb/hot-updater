import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { ComponentProps, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { InsightsEventRow } from "@/lib/insights-view";

import { EventHistoryCard } from "./EventHistoryCard";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { readonly children: ReactNode }) => (
    <a href="/">{children}</a>
  ),
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

const renderCard = (props: Partial<ComponentProps<typeof EventHistoryCard>>) =>
  render(
    <EventHistoryCard
      error={null}
      eventsLocation={{ eventsBefore: Date.UTC(2026, 6, 18, 12) }}
      history={{ data: [event], nextCursor: null }}
      isFetching={false}
      isLoading={false}
      onNext={vi.fn()}
      onPrevious={vi.fn()}
      onRefresh={vi.fn()}
      pageNumber={1}
      {...props}
    />,
  );

const nextButton = () =>
  within(
    screen.getByRole("navigation", { name: "All events pagination" }),
  ).getByRole("button", { name: "Next" }) as HTMLButtonElement;

afterEach(cleanup);

describe("EventHistoryCard", () => {
  it("offers four time ranges and reports the one chosen", () => {
    const onRangeChange = vi.fn();
    renderCard({ onRangeChange, range: "7d" });

    const ranges = within(screen.getByRole("tablist", { name: "Time range" }));
    expect(
      ranges.getAllByRole("tab").map((tab) => tab.getAttribute("aria-label")),
    ).toEqual(["Last 24 hours", "Last 7 days", "Last 30 days", "Last 90 days"]);
    expect(
      ranges.getByRole("tab", { name: "Last 7 days", selected: true }),
    ).toBeDefined();
    fireEvent.click(ranges.getByRole("tab", { name: "Last 24 hours" }));
    expect(onRangeChange).toHaveBeenCalledWith("24h");
  });

  it("names an empty range and offers the next longer one", () => {
    const onRangeChange = vi.fn();
    renderCard({
      history: { data: [], nextCursor: null },
      onRangeChange,
      range: "7d",
    });

    expect(screen.getByText("No events in the last 7 days.")).toBeDefined();
    expect(
      screen.queryByRole("navigation", { name: "All events pagination" }),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Show the last 30 days" }),
    );
    expect(onRangeChange).toHaveBeenCalledWith("30d");
  });

  it("offers no longer range than the last 90 days", () => {
    renderCard({
      history: { data: [], nextCursor: null },
      onRangeChange: vi.fn(),
      range: "90d",
    });

    expect(screen.getByText("No events in the last 90 days.")).toBeDefined();
    expect(screen.queryByRole("button", { name: /^Show the last/ })).toBeNull();
  });

  it("says the range start is reached on the last page", () => {
    const onRangeChange = vi.fn();
    renderCard({ onRangeChange, pageNumber: 2, range: "24h" });

    expect(nextButton().disabled).toBe(true);
    expect(screen.getByText("Start of range reached")).toBeDefined();
    fireEvent.click(
      screen.getByRole("button", { name: "Show the last 7 days" }),
    );
    expect(onRangeChange).toHaveBeenCalledWith("7d");
  });

  it("keeps paging while the range has older events", () => {
    renderCard({
      history: { data: [event], nextCursor: "next" },
      onRangeChange: vi.fn(),
      range: "7d",
    });

    expect(nextButton().disabled).toBe(false);
    expect(screen.queryByText("Start of range reached")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Show the last/ })).toBeNull();
  });

  it("says an empty page after a full one has no older events", () => {
    renderCard({
      history: { data: [], nextCursor: null },
      onRangeChange: vi.fn(),
      pageNumber: 3,
      range: "7d",
    });

    expect(screen.getByText("No older events in this range.")).toBeDefined();
    expect(screen.queryByText(/next page/)).toBeNull();
    expect(screen.getByText("Start of range reached")).toBeDefined();
    expect(nextButton().disabled).toBe(true);
  });

  it("keeps a fixed-window list without a time range control", () => {
    renderCard({
      history: { data: [], nextCursor: null },
      title: "Applied reports",
    });

    expect(screen.queryByRole("tablist")).toBeNull();
    expect(
      screen.getByText("No matching reports in this period"),
    ).toBeDefined();
    expect(screen.queryByText("Start of range reached")).toBeNull();
  });
});
