import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RecoveryReport } from "@/lib/insights-recovery";

import { InsightsOverview } from "./InsightsOverview";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="/">{children}</a>,
}));

const report: RecoveryReport = {
  downloads: 8,
  distribution: {
    coverage: { kind: "complete", sinceMs: 0 },
    measuredAtMs: 86_400_000,
    points: [
      {
        startMs: 0,
        bundles: [
          {
            appVersion: "1.0.0",
            releaseId: "release-a",
            bundleKind: "release",
            installations: 5,
          },
        ],
      },
    ],
  },
  activeInstallations: 5,
  activeDays: 20,
  failedLaunches: 2,
  points: [{ startMs: 0, dailyActiveInstallations: 20, failedLaunches: 2 }],
  startMs: 0,
  endMs: 86_400_000,
  measuredAtMs: 86_400_000,
  coverage: { kind: "complete", sinceMs: 0 },
};

const input = {
  platform: "ios",
  channel: "production",
  window: "7d",
} as const;

afterEach(cleanup);

describe("Release health", () => {
  it("shows the agreed metrics and derives crash rate from launch attempts", async () => {
    render(
      <InsightsOverview
        input={input}
        onWindowChange={vi.fn()}
        onRefresh={vi.fn()}
        query={{
          data: report,
          error: null,
          isPending: false,
          isFetching: false,
        }}
      />,
    );
    expect(screen.getByText("Active installations")).toBeDefined();
    // Active installations come from a sketch, so the value is an estimate.
    expect(screen.getByTitle("Estimated").textContent).toBe("≈Estimated 5");
    expect(
      screen.getByText("Active days").closest("div")?.querySelector("dd")
        ?.textContent,
    ).toBe("20");
    expect(screen.getByText("Failed launches")).toBeDefined();
    // 2 failed launches / (20 active days + 2 failed launches).
    expect(screen.getByText("9.09%")).toBeDefined();
    expect(screen.getByLabelText("Daily observed bundle share")).toBeDefined();
    expect(
      screen.getByRole("button", { name: "About active installations" }),
    ).toBeDefined();
    expect(
      screen.getByRole("button", { name: "About crash rate" }),
    ).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "About active days" }));
    expect((await screen.findByRole("tooltip")).textContent).toContain(
      "once for each UTC day it launched",
    );
  });

  it("shows the no-launch state instead of a zero crash rate", () => {
    render(
      <InsightsOverview
        input={input}
        onWindowChange={vi.fn()}
        onRefresh={vi.fn()}
        query={{
          data: { ...report, activeDays: 0, failedLaunches: 0, points: [] },
          error: null,
          isPending: false,
          isFetching: false,
        }}
      />,
    );
    expect(screen.getByText("— / No launch reports")).toBeDefined();
    fireEvent.click(screen.getByRole("tab", { name: "Launch failures" }));
    expect(screen.getByText("No launch reports in this period.")).toBeDefined();
  });

  it("keeps only the report period and refresh actions in the card", () => {
    const onWindowChange = vi.fn();
    render(
      <InsightsOverview
        input={input}
        onWindowChange={onWindowChange}
        onRefresh={vi.fn()}
        query={{
          data: report,
          error: null,
          isPending: false,
          isFetching: false,
        }}
      />,
    );
    expect(
      screen.queryByRole("form", { name: "Release health filters" }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "24 hours" }));
    expect(onWindowChange).toHaveBeenCalledWith("24h");
  });
});
