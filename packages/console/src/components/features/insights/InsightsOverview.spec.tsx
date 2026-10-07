import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { type ComponentProps, type ReactNode, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AdoptionRelease } from "@/lib/release-adoption";
import type {
  ComparedBundle,
  ReleaseHealthState,
} from "@/lib/release-adoption-api";

import { InsightsOverview as Overview } from "./InsightsOverview";

const mutations = vi.hoisted(() => ({
  preflight: vi.fn(async () => ({})),
  update: vi.fn(async () => ({})),
}));
vi.mock("@/lib/api", () => ({
  usePreflightReleaseMutation: () => ({
    mutateAsync: mutations.preflight,
    isPending: false,
  }),
  useUpdateReleaseMutation: () => ({
    mutateAsync: mutations.update,
    isPending: false,
  }),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="/">{children}</a>,
}));

const HOUR = 3_600_000;
const release = (
  releaseId: string,
  deployedAtMs: number,
  overrides: Partial<AdoptionRelease> = {},
): AdoptionRelease => ({
  releaseId,
  bundleId: `bundle-${releaseId}`,
  deployedAtMs,
  targetAppVersion: "1.2.0",
  enabled: true,
  revision: 3,
  ...overrides,
});
const newest = release("release-b", 20 * HOUR + 15 * 60_000);
const previous = release("release-a", 2 * HOUR);
const oldest = release("release-old", HOUR);

/** Counts of one type per hour of the period [6h, 30h). */
const seriesOf = (
  bundleId: string,
  type: "DOWNLOADED" | "LAUNCHED" | "RECOVERED",
  perHour: (hour: number) => number,
) => {
  const points = Array.from({ length: 24 }, (_, index) => ({
    startMs: (6 + index) * HOUR,
    events: perHour(6 + index),
  }));
  return {
    bundleId,
    type,
    measuredAtMs: 30 * HOUR - 30 * 60_000,
    points,
    total: points.reduce((sum, point) => sum + point.events, 0),
  };
};
// The new bundle takes over: its downloads and launches start, the
// previous one's launches stop. Each hour, one installation that downloaded
// the new bundle has yet to restart into it.
const bundles: readonly ComparedBundle[] = [
  {
    release: newest,
    downloaded: seriesOf(newest.bundleId, "DOWNLOADED", (hour) =>
      hour >= 20 ? 4 : 0,
    ),
    launched: seriesOf(newest.bundleId, "LAUNCHED", (hour) =>
      hour >= 20 ? 3 : 0,
    ),
    recovered: seriesOf(newest.bundleId, "RECOVERED", () => 0),
    error: null,
  },
  {
    release: previous,
    downloaded: seriesOf(previous.bundleId, "DOWNLOADED", () => 0),
    launched: seriesOf(previous.bundleId, "LAUNCHED", (hour) =>
      hour < 20 ? 1 : 0,
    ),
    recovered: seriesOf(previous.bundleId, "RECOVERED", () => 0),
    error: null,
  },
];
const health: ReleaseHealthState = {
  period: {
    startMs: 6 * HOUR,
    endMs: 30 * HOUR,
    durationMs: 24 * HOUR,
    intervalMs: HOUR,
  },
  candidates: [newest, previous, oldest],
  releases: bundles,
  isDefault: true,
  error: null,
  isFetching: false,
  refresh: vi.fn(),
};

const input = {
  platform: "ios",
  channel: "production",
  window: "24h",
} as const;

/** The card with its chart kept in state, as the route keeps it in the URL. */
function Card(
  props: Partial<Omit<ComponentProps<typeof Overview>, "health" | "chart">> & {
    readonly health?: Partial<ReleaseHealthState>;
    readonly chart?: ComponentProps<typeof Overview>["chart"];
  },
) {
  const [chart, setChart] = useState(props.chart ?? "adoption");
  return (
    <Overview
      input={input}
      onReleasesChange={vi.fn()}
      onWindowChange={vi.fn()}
      {...props}
      chart={chart}
      onChartChange={setChart}
      health={{ ...health, ...props.health }}
    />
  );
}

const renderCard = (props: ComponentProps<typeof Card> = {}) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Card {...props} />
    </QueryClientProvider>,
  );

const rows = () =>
  within(screen.getByRole("table", { name: "Compared bundles" }))
    .getAllByRole("row")
    .slice(1)
    .map((row) => row.textContent);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Release health", () => {
  it("opens on adoption: each bundle's downloads dashed and launches solid, per interval, named by its ID", () => {
    renderCard();
    expect(
      screen
        .getByRole("tab", { name: "Adoption" })
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(
      screen.getByLabelText(
        "Installations downloading (dashed) and launching (solid) each bundle per interval",
      ),
    ).toBeDefined();
    expect(screen.getByText("Hourly · last 24 hours · UTC")).toBeDefined();
    expect(
      within(screen.getByRole("list", { name: "Line styles" }))
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["Downloaded", "Launched"]);
    // One way to read the counts: no switch to running totals.
    expect(screen.queryByRole("tab", { name: "Cumulative" })).toBeNull();
    // The newest first, each named by its ID as on the Bundles page, with
    // its downloads and launches over the period.
    expect(
      within(screen.getByRole("table", { name: "Compared bundles" }))
        .getAllByRole("columnheader")
        .map((header) => header.textContent),
    ).toEqual(["Bundle", "Downloaded", "Launched", "Remove"]);
    expect(rows()).toEqual([
      "release-bDeployed Jan 1, 20:15 UTC · 1.2.04030",
      "release-aDeployed Jan 1, 02:00 UTC · 1.2.0014",
    ]);
    expect(
      screen.queryByRole("columnheader", { name: "Update failures" }),
    ).toBeNull();
  });

  it("charts a bundle downloaded but not launched yet, and waits for both counts", () => {
    const waiting = [
      {
        ...bundles[0]!,
        launched: seriesOf(newest.bundleId, "LAUNCHED", () => 0),
      },
    ];
    const view = renderCard({ health: { releases: waiting } });
    expect(
      screen.getByLabelText(
        "Installations downloading (dashed) and launching (solid) each bundle per interval",
      ),
    ).toBeDefined();
    expect(rows()).toEqual(["release-bDeployed Jan 1, 20:15 UTC · 1.2.0400"]);

    view.rerender(
      <QueryClientProvider client={new QueryClient()}>
        <Card
          health={{ releases: [{ ...bundles[0]!, downloaded: undefined }] }}
        />
      </QueryClientProvider>,
    );
    expect(screen.getByLabelText("Loading release health")).toBeDefined();
  });

  it("adds, removes, and resets the compared bundles", async () => {
    const onReleasesChange = vi.fn();
    const { rerender } = renderCard({ onReleasesChange });
    fireEvent.click(screen.getByRole("button", { name: "Remove release-b" }));
    expect(onReleasesChange).toHaveBeenLastCalledWith(["release-a"]);

    fireEvent.click(screen.getByRole("combobox", { name: "Add a bundle" }));
    const option = await screen.findByRole("option", {
      name: "release-old Deployed Jan 1, 01:00 UTC",
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
    // The newest bundles need no reset.
    expect(
      screen.queryByRole("button", { name: "Show the newest 2" }),
    ).toBeNull();

    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <Card
          onReleasesChange={onReleasesChange}
          health={{ isDefault: false }}
        />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Show the newest 2" }));
    expect(onReleasesChange).toHaveBeenLastCalledWith(undefined);
  });

  it("stops adding at four bundles", () => {
    const more = [3, 4].map((index) => ({
      ...bundles[1]!,
      release: release(`release-${index}`, index * HOUR),
    }));
    renderCard({ health: { releases: [...bundles, ...more] } });
    const add = screen.getByRole("combobox", { name: "Add a bundle" });
    expect(add.textContent).toContain("Up to 4 bundles");
  });

  it("charts crashes and their rate, and calls for no rollback below 20 attempts", () => {
    renderCard({
      chart: "crashes",
      health: {
        releases: [
          {
            ...bundles[0]!,
            // 1 crash of 9 attempts: 11.1%, too few to act on.
            launched: seriesOf(newest.bundleId, "LAUNCHED", (hour) =>
              hour === 21 ? 8 : 0,
            ),
            recovered: seriesOf(newest.bundleId, "RECOVERED", (hour) =>
              hour === 22 ? 1 : 0,
            ),
          },
          bundles[1]!,
        ],
      },
    });
    expect(
      screen.getByLabelText("Crashes of each bundle per interval"),
    ).toBeDefined();
    // Named as the bundle's activity names it.
    expect(
      within(screen.getByRole("table", { name: "Compared bundles" }))
        .getAllByRole("columnheader")
        .map((header) => header.textContent),
    ).toEqual(["Bundle", "Crashed", "Crash rate", "Remove"]);
    expect(rows()).toEqual([
      "release-bDeployed Jan 1, 20:15 UTC · 1.2.0111.1%",
      "release-aDeployed Jan 1, 02:00 UTC · 1.2.000.0%",
    ]);
    expect(screen.queryByRole("button", { name: "Roll back" })).toBeNull();
    // A crash count is a number, with no details to open.
    expect(screen.queryByRole("button", { name: /crashes of/ })).toBeNull();
  });

  it("recommends rolling back a bundle that crashes for 5% of 20 attempts, and disables it", async () => {
    renderCard({
      chart: "crashes",
      health: {
        releases: [
          {
            ...bundles[0]!,
            // 2 crashes of 20 attempts: 10%.
            launched: seriesOf(newest.bundleId, "LAUNCHED", (hour) =>
              hour === 21 ? 18 : 0,
            ),
            recovered: seriesOf(newest.bundleId, "RECOVERED", (hour) =>
              hour === 22 ? 2 : 0,
            ),
          },
          bundles[1]!,
        ],
      },
    });
    expect(
      screen.getByRole("tab", { name: "Crashes, rollback recommended" }),
    ).toBeDefined();
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Roll back release-b");
    expect(alert.textContent).toContain(
      "It crashed for 10.0% of the installations that tried it (2 of 20), above 5.0%.",
    );
    expect(rows()[0]).toContain("10.0%, rollback recommended");

    fireEvent.click(within(alert).getByRole("button", { name: "Roll back" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Roll back this bundle?")).toBeDefined();
    expect(within(dialog).getByText("release-b")).toBeDefined();
    await act(async () => {
      fireEvent.click(
        within(dialog).getByRole("button", { name: "Roll back" }),
      );
    });
    const disable = {
      expectedRevision: 3,
      patch: { enabled: false },
      releaseId: "release-b",
    };
    expect(mutations.preflight).toHaveBeenCalledWith(disable);
    await waitFor(() => expect(mutations.update).toHaveBeenCalledWith(disable));
  });

  it("offers a longer period when no installation downloaded or launched the bundles, and says when nothing crashed", () => {
    const onWindowChange = vi.fn();
    const quiet = bundles.map((bundle) => ({
      ...bundle,
      downloaded: seriesOf(bundle.release.bundleId, "DOWNLOADED", () => 0),
      launched: seriesOf(bundle.release.bundleId, "LAUNCHED", () => 0),
    }));
    renderCard({ onWindowChange, health: { releases: quiet } });
    expect(
      screen.getByText(
        "No installation downloaded or launched these bundles in the last 24 hours",
      ),
    ).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Show 7 days" }));
    expect(onWindowChange).toHaveBeenCalledWith("7d");

    fireEvent.click(screen.getByRole("tab", { name: "Crashes" }));
    expect(screen.getByText("No crashes in the last 24 hours")).toBeDefined();
  });

  it("loads, then says when the scope has no bundle deployments", () => {
    const { rerender } = renderCard({
      health: { releases: undefined, candidates: undefined },
    });
    expect(screen.getByLabelText("Loading release health")).toBeDefined();
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <Card health={{ releases: [], candidates: [] }} />
      </QueryClientProvider>,
    );
    expect(screen.getByText("No bundles deployed here yet")).toBeDefined();
  });

  it("keeps the period and refresh in the card header", () => {
    const onWindowChange = vi.fn();
    const refresh = vi.fn();
    renderCard({ onWindowChange, health: { refresh } });
    fireEvent.click(screen.getByRole("tab", { name: "7 days" }));
    expect(onWindowChange).toHaveBeenCalledWith("7d");
    fireEvent.click(
      screen.getByRole("button", { name: "Refresh release health" }),
    );
    expect(refresh).toHaveBeenCalled();
  });
});
