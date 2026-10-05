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
  message: string | null,
  overrides: Partial<AdoptionRelease> = {},
): AdoptionRelease => ({
  releaseId,
  bundleId: `bundle-${releaseId}`,
  deployedAtMs,
  message,
  targetAppVersion: "1.2.0",
  enabled: true,
  revision: 3,
  ...overrides,
});
const newest = release("release-b", 20 * HOUR + 15 * 60_000, "Fix checkout");
const previous = release("release-a", 2 * HOUR, null);
const oldest = release("release-old", HOUR, "First release");

/** Reports of one type per hour of the period [6h, 30h). */
const seriesOf = (
  bundleId: string,
  type: "UPDATE_APPLIED" | "RECOVERED" | "UPDATE_FAILED",
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
// The new bundle takes over: its applies start, the previous one's stop.
const bundles: readonly ComparedBundle[] = [
  {
    release: newest,
    applied: seriesOf(newest.bundleId, "UPDATE_APPLIED", (hour) =>
      hour >= 20 ? 3 : 0,
    ),
    failed: seriesOf(newest.bundleId, "UPDATE_FAILED", (hour) =>
      hour === 21 ? 2 : 0,
    ),
    recovered: seriesOf(newest.bundleId, "RECOVERED", () => 0),
    error: null,
  },
  {
    release: previous,
    applied: seriesOf(previous.bundleId, "UPDATE_APPLIED", (hour) =>
      hour < 20 ? 1 : 0,
    ),
    failed: seriesOf(previous.bundleId, "UPDATE_FAILED", () => 0),
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
      onShowDetails={vi.fn()}
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
  it("opens on adoption: installations applying each bundle, and its update failures", () => {
    const onShowDetails = vi.fn();
    renderCard({ onShowDetails });
    expect(
      screen
        .getByRole("tab", { name: "Adoption" })
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(
      screen.getByLabelText("Installations applying each bundle per interval"),
    ).toBeDefined();
    expect(screen.getByText("Hourly · last 24 hours · UTC")).toBeDefined();
    // The newest first; a message names a bundle, an ID one without.
    expect(rows()).toEqual([
      "Fix checkoutDeployed Jan 1, 20:15 UTC · 1.2.0302",
      "release-…se-aDeployed Jan 1, 02:00 UTC · 1.2.0140",
    ]);
    fireEvent.click(
      screen.getByRole("button", {
        name: "2 update failures of Fix checkout: view details",
      }),
    );
    expect(onShowDetails).toHaveBeenCalledWith("release-b", "updates");
  });

  it("adds, removes, and resets the compared bundles", async () => {
    const onReleasesChange = vi.fn();
    const { rerender } = renderCard({ onReleasesChange });
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
      release: release(`release-${index}`, index * HOUR, null),
    }));
    renderCard({ health: { releases: [...bundles, ...more] } });
    const add = screen.getByRole("combobox", { name: "Add a bundle" });
    expect(add.textContent).toContain("Up to 4 bundles");
  });

  it("charts crashes and their rate, and calls for no rollback below 20 attempts", () => {
    const onShowDetails = vi.fn();
    renderCard({
      chart: "crashes",
      onShowDetails,
      health: {
        releases: [
          {
            ...bundles[0]!,
            // 1 crash of 9 attempts: 11.1%, too few to act on.
            applied: seriesOf(newest.bundleId, "UPDATE_APPLIED", (hour) =>
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
    expect(rows()).toEqual([
      "Fix checkoutDeployed Jan 1, 20:15 UTC · 1.2.0111.1%",
      "release-…se-aDeployed Jan 1, 02:00 UTC · 1.2.000.0%",
    ]);
    expect(screen.queryByRole("button", { name: "Roll back" })).toBeNull();
    fireEvent.click(
      screen.getByRole("button", {
        name: "1 crashes of Fix checkout: view details",
      }),
    );
    expect(onShowDetails).toHaveBeenCalledWith("release-b", "crashes");
  });

  it("recommends rolling back a bundle that crashes for 5% of 20 attempts, and disables it", async () => {
    renderCard({
      chart: "crashes",
      health: {
        releases: [
          {
            ...bundles[0]!,
            // 2 crashes of 20 attempts: 10%.
            applied: seriesOf(newest.bundleId, "UPDATE_APPLIED", (hour) =>
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
    expect(alert.textContent).toContain("Roll back Fix checkout");
    expect(alert.textContent).toContain(
      "It crashed for 10.0% of the installations that tried it (2 of 20), above 5.0%.",
    );
    expect(rows()[0]).toContain("10.0%, rollback recommended");

    fireEvent.click(within(alert).getByRole("button", { name: "Roll back" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Roll back Fix checkout?")).toBeDefined();
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

  it("offers a longer period when no installation applied the bundles, and says when nothing crashed", () => {
    const onWindowChange = vi.fn();
    const quiet = bundles.map((bundle) => ({
      ...bundle,
      applied: seriesOf(bundle.release.bundleId, "UPDATE_APPLIED", () => 0),
    }));
    renderCard({ onWindowChange, health: { releases: quiet } });
    expect(
      screen.getByText(
        "No installations applied these bundles in the last 24 hours",
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
