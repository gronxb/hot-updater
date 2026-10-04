import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { type ComponentProps, type ReactNode, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RecoveryReport } from "@/lib/insights-recovery";
import type { DownloadsRelease } from "@/lib/release-downloads";

import { InsightsOverview as Overview } from "./InsightsOverview";
import type { ReleaseDownloadsProps } from "./ReleaseDownloadsChart";

const HOUR = 3_600_000;
const release = (
  releaseId: string,
  deployedAtMs: number,
  message: string | null,
): DownloadsRelease => ({
  releaseId,
  deployedAtMs,
  message,
  targetAppVersion: "1.2.0",
});
const newest = release("release-b", 20 * HOUR + 15 * 60_000, "Fix checkout");
const previous = release("release-a", 2 * HOUR, null);
const oldest = release("release-old", HOUR, "First release");
/** Downloads per hour of the period [6h, 30h), from the given hour on. */
const seriesOf = (releaseId: string, perHour: (hour: number) => number) => {
  const points = Array.from({ length: 24 }, (_, index) => ({
    startMs: (6 + index) * HOUR,
    downloads: perHour(6 + index),
  }));
  return {
    releaseId,
    measuredAtMs: 30 * HOUR - 30 * 60_000,
    coverage: { kind: "complete" as const, sinceMs: 0 },
    points,
    totalDownloads: points.reduce((sum, point) => sum + point.downloads, 0),
  };
};
const downloads: ReleaseDownloadsProps = {
  period: {
    startMs: 6 * HOUR,
    endMs: 30 * HOUR,
    durationMs: 24 * HOUR,
    intervalMs: HOUR,
  },
  candidates: [newest, previous, oldest],
  // The new bundle takes over: its downloads start, the previous one's stop.
  releases: [
    {
      release: newest,
      series: seriesOf("release-b", (hour) => (hour >= 20 ? 3 : 0)),
      error: null,
    },
    {
      release: previous,
      series: seriesOf("release-a", (hour) => (hour < 20 ? 1 : 0)),
      error: null,
    },
  ],
  isDefault: true,
  error: null,
  onReleasesChange: vi.fn(),
};

/** The card with its chart tab kept in state, as the route keeps it in the URL. */
function InsightsOverview(
  props: Omit<
    ComponentProps<typeof Overview>,
    "chart" | "onChartChange" | "downloads"
  > & {
    readonly downloads?: Partial<ComponentProps<typeof Overview>["downloads"]>;
  },
) {
  const [chart, setChart] =
    useState<ComponentProps<typeof Overview>["chart"]>("share");
  return (
    <Overview
      {...props}
      chart={chart}
      onChartChange={setChart}
      downloads={{ ...downloads, ...props.downloads }}
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

  it("charts the newest bundles on the period's timeline, and adds, removes, and resets them", async () => {
    const onReleasesChange = vi.fn();
    const { rerender } = render(
      <InsightsOverview
        input={input}
        onWindowChange={vi.fn()}
        onRefresh={vi.fn()}
        downloads={{ onReleasesChange }}
        query={{
          data: report,
          error: null,
          isPending: false,
          isFetching: false,
        }}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: "Downloads" }));
    expect(
      screen.getByLabelText("Downloads of each bundle per interval"),
    ).toBeDefined();
    expect(screen.getByText("Hourly · last 24 hours · UTC")).toBeDefined();
    const table = screen.getByRole("table", { name: "Compared bundles" });
    const rows = within(table).getAllByRole("row").slice(1);
    // The newest first; its message names it, an ID names one without.
    expect(rows.map((row) => row.textContent)).toEqual([
      "Fix checkoutDeployed Jan 1, 20:15 UTC · 1.2.030",
      "release-…se-aDeployed Jan 1, 02:00 UTC · 1.2.014",
    ]);
    // The newest bundles need no reset.
    expect(
      screen.queryByRole("button", { name: "Show the newest 2" }),
    ).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Remove Fix checkout" }),
    );
    expect(onReleasesChange).toHaveBeenLastCalledWith(["release-a"]);

    fireEvent.click(screen.getByRole("combobox", { name: "Add a bundle" }));
    const option = await screen.findByRole("option", {
      name: "First release · Jan 1, 01:00 UTC",
    });
    await act(async () => {
      fireEvent.pointerDown(option);
      fireEvent.click(option);
    });
    expect(onReleasesChange).toHaveBeenLastCalledWith([
      "release-b",
      "release-a",
      "release-old",
    ]);

    rerender(
      <InsightsOverview
        input={input}
        onWindowChange={vi.fn()}
        onRefresh={vi.fn()}
        downloads={{ onReleasesChange, isDefault: false }}
        query={{
          data: report,
          error: null,
          isPending: false,
          isFetching: false,
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Show the newest 2" }));
    expect(onReleasesChange).toHaveBeenLastCalledWith(undefined);
  });

  it("stops adding at four bundles", () => {
    const more = [3, 4].map((index) => ({
      release: release(`release-${index}`, index * HOUR, null),
      series: seriesOf(`release-${index}`, () => 0),
      error: null,
    }));
    render(
      <InsightsOverview
        input={input}
        onWindowChange={vi.fn()}
        onRefresh={vi.fn()}
        downloads={{ releases: [...downloads.releases!, ...more] }}
        query={{
          data: report,
          error: null,
          isPending: false,
          isFetching: false,
        }}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: "Downloads" }));
    const add = screen.getByRole("combobox", { name: "Add a bundle" });
    expect(add.textContent).toContain("Up to 4 bundles");
    expect(
      add.hasAttribute("disabled") ||
        add.getAttribute("data-disabled") !== null,
    ).toBe(true);
  });

  it("offers a longer period when the bundles have no downloads in this one", () => {
    const onWindowChange = vi.fn();
    render(
      <InsightsOverview
        input={{ ...input, window: "24h" }}
        onWindowChange={onWindowChange}
        onRefresh={vi.fn()}
        downloads={{
          releases: downloads.releases!.map((entry) => ({
            ...entry,
            series: seriesOf(entry.release.releaseId, () => 0),
          })),
        }}
        query={{
          data: report,
          error: null,
          isPending: false,
          isFetching: false,
        }}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: "Downloads" }));
    expect(
      screen.getByText("No downloads of these bundles in the last 24 hours"),
    ).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Show 7 days" }));
    expect(onWindowChange).toHaveBeenCalledWith("7d");
  });

  it("says when the scope has no bundle deployments, and loads before it knows", () => {
    const { rerender } = render(
      <InsightsOverview
        input={input}
        onWindowChange={vi.fn()}
        onRefresh={vi.fn()}
        downloads={{ releases: undefined, candidates: undefined }}
        query={{
          data: report,
          error: null,
          isPending: false,
          isFetching: false,
        }}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: "Downloads" }));
    expect(screen.getByLabelText("Loading downloads")).toBeDefined();
    rerender(
      <InsightsOverview
        input={input}
        onWindowChange={vi.fn()}
        onRefresh={vi.fn()}
        downloads={{ releases: [], candidates: [] }}
        query={{
          data: report,
          error: null,
          isPending: false,
          isFetching: false,
        }}
      />,
    );
    expect(screen.getByText("No bundles deployed here yet")).toBeDefined();
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
