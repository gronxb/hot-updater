import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { InstallationMatchesCard } from "./InstallationMatchesCard";

const results = {
  data: [
    {
      installId: "install-a",
      userId: "user-a",
      username: null,
      lastKnownBundleId: "bundle-a",
      latestStatus: "UNCHANGED" as const,
      platform: "ios" as const,
      appVersion: "1.0.0",
      channel: "production",
      cohort: "default",
      receivedAtMs: Date.UTC(2026, 6, 18),
    },
  ],
  pagination: { total: 1, limit: 20, offset: 0 },
};

describe("InstallationMatchesCard", () => {
  afterEach(cleanup);

  it("closes the mobile chooser and restores its trigger after selecting a match", () => {
    const onSelect = vi.fn();
    render(
      <InstallationMatchesCard
        error={null}
        limit={20}
        offset={0}
        onOffsetChange={vi.fn()}
        onSelect={onSelect}
        results={results}
        selectedInstallId=""
      />,
    );
    const trigger = screen.getByRole("button", {
      name: "Show matching installations",
    });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(
      screen.getByRole("button", { name: "user-a, install ID install-a" }),
    );
    expect(onSelect).toHaveBeenCalledWith("install-a");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
  });

  it("keeps empty and error states outside the collapsed chooser", () => {
    const props = {
      error: null,
      limit: 20,
      offset: 0,
      onOffsetChange: vi.fn(),
      onSelect: vi.fn(),
      results: {
        ...results,
        data: [],
        pagination: { ...results.pagination, total: 0 },
      },
      selectedInstallId: "",
    };
    const { rerender } = render(<InstallationMatchesCard {...props} />);
    expect(
      screen.queryByRole("button", { name: "Show matching installations" }),
    ).toBeNull();
    expect(screen.getByText("No matches")).toBeDefined();
    expect(
      screen.getByRole("link", { name: "Edit search" }).getAttribute("href"),
    ).toBe("#installation-history-search");

    rerender(
      <InstallationMatchesCard
        {...props}
        error={new Error("Connection lost")}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "Show matching installations" }),
    ).toBeNull();
    expect(screen.getByRole("alert")).toBeDefined();
  });
});
