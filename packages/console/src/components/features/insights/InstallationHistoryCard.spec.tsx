import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { InstallationHistoryCard } from "./InstallationHistoryCard";

const event = {
  id: "00000000-0000-7000-8000-000000000001",
  installId: "install-alpha",
  type: "UPDATE_APPLIED" as const,
  fromBundleId: "00000000-0000-7000-8000-000000000002",
  toBundleId: "00000000-0000-7000-8000-000000000003",
  username: null,
  userId: "user-alpha",
  platform: "ios" as const,
  appVersion: "1.4.2",
  channel: "production",
  cohort: "stable",
  receivedAtMs: Date.UTC(2026, 6, 18),
};

describe("InstallationHistoryCard", () => {
  afterEach(cleanup);

  it("shows the selected installation and its event history", () => {
    render(
      <InstallationHistoryCard
        error={null}
        history={{ data: [event], hasNext: false, nextCursor: null, total: 1 }}
        isLoading={false}
        onNext={vi.fn()}
        onPrevious={vi.fn()}
        pageNumber={1}
        selectedEvent={event}
        selectedInstallId={event.installId}
      />,
    );
    expect(
      screen.getByRole("heading", { name: /installation history/i }),
    ).toBeDefined();
    expect(screen.getAllByText("Bundle applied").length).toBeGreaterThan(0);
    expect(screen.getByText("user-alpha")).toBeDefined();
  });

  it("keeps navigation available on an empty later cursor page", () => {
    render(
      <InstallationHistoryCard
        error={null}
        history={{ data: [], hasNext: false, nextCursor: null, total: null }}
        isLoading={false}
        onNext={vi.fn()}
        onPrevious={vi.fn()}
        pageNumber={2}
        selectedEvent={event}
        selectedInstallId={event.installId}
      />,
    );
    expect(screen.getByText("No bundle changes on this page.")).toBeDefined();
    expect(screen.getByRole("button", { name: /previous/i })).toBeDefined();
  });
});
