import { cleanup, render, screen, within } from "@testing-library/react";
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
      within(table).getByRole("columnheader", { name: "App version" }),
    ).toBeDefined();
    expect(within(table).getByText("2.4.1")).toBeDefined();
  });
});
