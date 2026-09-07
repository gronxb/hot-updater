import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { InsightsEventRow } from "@/lib/insights-view";

import { InstallationHistoryCard } from "./InstallationHistoryCard";

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
    expect(screen.getAllByText("Bundle applied").length).toBeGreaterThan(0);
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
});
