import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { InsightsInstallationViewRow } from "@/lib/insights-view";

import { InstallationMatchesCard } from "./InstallationMatchesCard";

const row: InsightsInstallationViewRow = {
  appVersion: "1.2.3",
  channel: "production",
  cohort: "1",
  installId: "install-1",
  lastKnownBundleId: "bundle-1",
  latestStatus: "UNCHANGED",
  platform: "ios",
  receivedAtMs: Date.UTC(2026, 6, 18),
  userId: "user-1",
  username: null,
};

describe("InstallationMatchesCard", () => {
  afterEach(cleanup);

  it("selects one of multiple exact user installations", () => {
    const onSelect = vi.fn();
    render(
      <InstallationMatchesCard
        error={null}
        onNext={vi.fn()}
        onPrevious={vi.fn()}
        onSelect={onSelect}
        pageNumber={1}
        results={{
          data: [row, { ...row, installId: "install-2" }],
          nextCursor: null,
        }}
        selectedInstallId="install-1"
      />,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "user-1, install ID install-2",
      }),
    );
    expect(onSelect).toHaveBeenCalledWith("install-2");
  });
});
