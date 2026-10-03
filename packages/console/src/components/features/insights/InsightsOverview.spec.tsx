import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { type ComponentProps, type ReactNode, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RecoveryReport } from "@/lib/insights-recovery";

import { InsightsOverview as Overview } from "./InsightsOverview";

/** The card with its chart tab kept in state, as the route keeps it in the URL. */
function InsightsOverview(
  props: Omit<
    ComponentProps<typeof Overview>,
    "chart" | "onChartChange" | "onReleaseChange"
  > & { readonly onReleaseChange?: (releaseId: string) => void },
) {
  const [chart, setChart] =
    useState<ComponentProps<typeof Overview>["chart"]>("share");
  return (
    <Overview
      {...props}
      chart={chart}
      onChartChange={setChart}
      onReleaseChange={props.onReleaseChange ?? vi.fn()}
    />
  );
}

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
  adoption: null,
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

  it("asks for a bundle, then shows its cumulative downloads from deployment", () => {
    const hour = 3_600_000;
    const onReleaseChange = vi.fn();
    const { rerender } = render(
      <InsightsOverview
        input={input}
        onWindowChange={vi.fn()}
        onRefresh={vi.fn()}
        onReleaseChange={onReleaseChange}
        query={{
          data: report,
          error: null,
          isPending: false,
          isFetching: false,
        }}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: "Adoption" }));
    expect(screen.getByText("Choose a bundle to chart")).toBeDefined();
    expect(
      screen.getByRole("combobox", { name: "Chart bundle" }),
    ).toBeDefined();
    // The observed release is one click away.
    fireEvent.click(
      screen.getByRole("button", { name: "Chart newest bundle" }),
    );
    expect(onReleaseChange).toHaveBeenCalledWith("release-a");
    rerender(
      <InsightsOverview
        input={{ ...input, releaseId: "release-a" }}
        onWindowChange={vi.fn()}
        onRefresh={vi.fn()}
        query={{
          data: {
            ...report,
            adoption: {
              deployedAtMs: 13 * hour + 20 * 60_000,
              intervalMs: 6 * hour,
              points: [
                { startMs: 13 * hour, downloads: 4, totalDownloads: 4 },
                { startMs: 19 * hour, downloads: 2, totalDownloads: 6 },
              ],
            },
          },
          error: null,
          isPending: false,
          isFetching: false,
        }}
      />,
    );
    expect(
      screen.getByLabelText("Cumulative downloads of the chosen bundle"),
    ).toBeDefined();
    expect(screen.getByText("downloads since deployment")).toBeDefined();
    expect(
      screen.getByText("downloads since deployment").previousSibling
        ?.textContent,
    ).toBe("6");
    expect(screen.getByText("Deployed Jan 1, 13:20 UTC")).toBeDefined();
  });

  it("offers the period that covers a release deployed before this one", () => {
    const day = 86_400_000;
    const onWindowChange = vi.fn();
    render(
      <InsightsOverview
        input={{ ...input, window: "24h", releaseId: "release-a" }}
        onWindowChange={onWindowChange}
        onRefresh={vi.fn()}
        query={{
          data: {
            ...report,
            startMs: 9 * day,
            endMs: 10 * day,
            measuredAtMs: 10 * day,
            adoption: { deployedAtMs: null, intervalMs: day / 24, points: [] },
          },
          error: null,
          isPending: false,
          isFetching: false,
        }}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: "Adoption" }));
    expect(
      screen.getByText("No downloads of this bundle in this period"),
    ).toBeDefined();
    // "release-a" is no UUIDv7, so 7 days is the period offered.
    fireEvent.click(screen.getByRole("button", { name: "Show 7 days" }));
    expect(onWindowChange).toHaveBeenCalledWith("7d");
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
