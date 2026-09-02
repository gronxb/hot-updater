import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { InstallationMatchesCard } from "./InstallationMatchesCard";

const row = {
  id: "00000000-0000-7000-8000-000000000001",
  installId: "install-alpha",
  userId: "user-alpha",
  username: null,
  lastKnownBundleId: "00000000-0000-7000-8000-000000000002",
  latestStatus: "UNCHANGED" as const,
  type: "UNCHANGED" as const,
  toBundleId: "00000000-0000-7000-8000-000000000002",
  platform: "ios" as const,
  appVersion: "1.4.2",
  channel: "production",
  cohort: "stable",
  receivedAtMs: Date.UTC(2026, 6, 18),
};

describe("InstallationMatchesCard", () => {
  afterEach(cleanup);

  it("selects a result and exposes cursor pagination state", () => {
    const onSelect = vi.fn();
    const onNext = vi.fn();
    render(
      <InstallationMatchesCard
        error={null}
        onNext={onNext}
        onPrevious={vi.fn()}
        onSelect={onSelect}
        pageNumber={1}
        results={{
          data: [row],
          hasNext: true,
          nextCursor: "next",
          total: null,
        }}
        selectedInstallId={undefined}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: /user-alpha, install id install-alpha/i,
      }),
    );
    expect(onSelect).toHaveBeenCalledWith("install-alpha");
    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    expect(onNext).toHaveBeenCalledOnce();
  });

  it("renders an actionable empty state", () => {
    render(
      <InstallationMatchesCard
        error={null}
        onNext={vi.fn()}
        onPrevious={vi.fn()}
        onSelect={vi.fn()}
        pageNumber={1}
        results={{ data: [], hasNext: false, nextCursor: null, total: 0 }}
        selectedInstallId={undefined}
      />,
    );
    expect(screen.getByText("No matches")).toBeDefined();
    expect(
      screen.getByRole("link", { name: "Edit search" }).getAttribute("href"),
    ).toBe("#installation-history-search");
  });
});
