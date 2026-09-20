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
  uniqueUsers: 5,
  launches: 20,
  failedLaunches: 2,
  points: [{ startMs: 0, launches: 20, failedLaunches: 2 }],
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
  it("shows the agreed metrics and derives crash rate from launch attempts", () => {
    render(
      <InsightsOverview
        input={input}
        onInputChange={vi.fn()}
        onRefresh={vi.fn()}
        query={{
          data: report,
          error: null,
          isPending: false,
          isFetching: false,
        }}
      />,
    );
    expect(screen.getByText("Unique users")).toBeDefined();
    expect(screen.getByText("Launches")).toBeDefined();
    expect(screen.getByText("Failed launches")).toBeDefined();
    expect(screen.getByText("9.09%")).toBeDefined();
    expect(
      screen.getByLabelText("Daily launches and failed launches"),
    ).toBeDefined();
  });

  it("shows the no-launch state instead of a zero crash rate", () => {
    render(
      <InsightsOverview
        input={input}
        onInputChange={vi.fn()}
        onRefresh={vi.fn()}
        query={{
          data: { ...report, launches: 0, failedLaunches: 0, points: [] },
          error: null,
          isPending: false,
          isFetching: false,
        }}
      />,
    );
    expect(screen.getByText("— / No launch reports")).toBeDefined();
    expect(screen.getByText("No launch reports in this period.")).toBeDefined();
  });

  it("submits platform, channel, and optional release filters", () => {
    const onInputChange = vi.fn();
    render(
      <InsightsOverview
        input={input}
        onInputChange={onInputChange}
        onRefresh={vi.fn()}
        query={{
          data: report,
          error: null,
          isPending: false,
          isFetching: false,
        }}
      />,
    );
    fireEvent.change(screen.getByLabelText("Release health channel"), {
      target: { value: "preview" },
    });
    fireEvent.change(screen.getByLabelText("Release ID optional"), {
      target: { value: "release-a" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(onInputChange).toHaveBeenCalledWith({
      platform: "ios",
      channel: "preview",
      window: "7d",
      releaseId: "release-a",
    });
  });
});
