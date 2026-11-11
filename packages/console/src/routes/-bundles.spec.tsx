import type { Bundle, ReleaseRow } from "@hot-updater/plugin-core";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { ComponentType, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  releasesQuery: vi.fn(),
  foldQuery: vi.fn(),
  isMobile: vi.fn(() => false),
  activity: vi.fn(),
  navigate: vi.fn(),
  search: vi.fn(),
  insightsAnalytics: true,
}));

vi.mock("@/lib/bundle-activity", () => ({
  useBundleActivityQuery: mocks.activity,
}));
vi.mock("@/lib/console-features-api", () => ({
  useConsoleFeatures: () => ({
    data: {
      features: {
        insights: true,
        insightsAnalytics: mocks.insightsAnalytics,
        apiKeys: true,
      },
      remote: false,
    },
  }),
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({
    ...options,
    useNavigate: () => mocks.navigate,
    useSearch: mocks.search,
  }),
  Link: ({ children, to }: { children: ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));

vi.mock("@/components/features/channels/ChannelManagementDialog", () => ({
  ChannelManagementDialog: () => null,
}));
vi.mock("@/components/features/releases/ReleaseEditorSheet", () => ({
  ReleaseEditorSheet: () => null,
}));
vi.mock("@/components/ui/select", () => ({
  Select: ({ children }: { children: ReactNode }) => children,
  SelectContent: ({ children }: { children: ReactNode }) => children,
  SelectGroup: ({ children }: { children: ReactNode }) => children,
  SelectItem: ({ children }: { children: ReactNode }) => (
    <span>{children}</span>
  ),
  SelectTrigger: ({ children }: { children: ReactNode }) => (
    <button type="button">{children}</button>
  ),
  SelectValue: () => null,
}));
vi.mock("@/components/ui/sidebar", () => ({
  SidebarTrigger: () => null,
}));
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: mocks.isMobile }));

const release = vi.hoisted(
  () =>
    ({
      bundle_id: "019ff641-01eb-72ea-8a03-a28aef188d32",
      channel_id: "channel-1",
      created_at_ms: Date.UTC(2026, 6, 18),
      enabled: true,
      fingerprint_hash: null,
      id: "release-1",
      kind: "BUNDLE",
      message: "Stable release",
      operation: "DEPLOY",
      platform: "ios",
      revision: 1,
      rollout_cohort_count: 1_000,
      scope_key: "scope-1",
      should_force_update: false,
      source_release_id: null,
      strategy: "APP_VERSION",
      target_app_version: "1.2.x",
      target_cohorts: [],
      updated_at_ms: Date.UTC(2026, 6, 18),
      currentlyUnreachable: false,
    }) as ReleaseRow & { currentlyUnreachable: boolean },
);
const baseBundle = {
  id: "019ff641-01eb-72ea-8a03-a28aef188d32",
  platform: "ios",
} as Bundle;
const childBundle = {
  id: "019ff642-01eb-72ea-8a03-a28aef188d33",
  platform: "ios",
} as Bundle;
let releases = [release];
/** The page the server gives: `releases` as rows, unless a test sets it. */
let entries: FoldedEntry<ReleaseListRow>[] | null = null;

vi.mock("@/lib/api", () => ({
  useBundleChildCountsQuery: () => ({
    data: { "019ff641-01eb-72ea-8a03-a28aef188d32": 1 },
  }),
  useBundleChildrenQuery: () => ({
    data: [childBundle],
    isError: false,
    isPending: false,
  }),
  useBundleQuery: () => ({
    data: baseBundle,
    isError: false,
    isPending: false,
  }),
  useChannelsQuery: () => ({
    data: [
      {
        id: "channel-1",
        name: "e2e-job-20260812132427-qy22fi-android-s2-production",
      },
    ],
  }),
  useReleaseFoldQuery: mocks.foldQuery,
  useReleasesQuery: mocks.releasesQuery,
}));

import type { FoldedEntry } from "@/lib/server/foldedPage";
import type { ReleaseListRow } from "@/lib/server/releaseReachability";

import { Route } from "./index";

const BundlesPage = (Route as unknown as { readonly component: ComponentType })
  .component;

describe("BundlesPage", () => {
  it.each([false, true])(
    "shows release insights on desktop and mobile (%s)",
    (mobile) => {
      mocks.isMobile.mockReturnValue(mobile);
      render(<BundlesPage />);
      const summary = screen.getByRole("link", {
        name: /Downloaded 107 Launched 98 Crashed 2/,
      });
      expect(
        within(summary)
          .getAllByRole("term")
          .map((term) => term.textContent),
      ).toEqual(["Downloaded", "Launched", "Crashed"]);
      expect(
        within(summary)
          .getAllByRole("definition")
          .map((value) => value.textContent),
        // Crashes over launches plus crashes: 2 of 98 + 2.
      ).toEqual(["107", "98", "2(2.00%)"]);
      expect(mocks.activity).toHaveBeenCalledWith([
        {
          platform: "ios",
          channel: "e2e-job-20260812132427-qy22fi-android-s2-production",
          releaseId: "release-1",
          builtIn: false,
        },
      ]);
    },
  );
  it.each([false, true])(
    "leaves release insights out where the console does not read them (mobile: %s)",
    (mobile) => {
      mocks.isMobile.mockReturnValue(mobile);
      mocks.insightsAnalytics = false;
      render(<BundlesPage />);

      expect(screen.queryByText("Insights")).toBeNull();
      expect(screen.queryByText(/Downloaded/)).toBeNull();
      expect(
        screen.queryByLabelText("Release insights unavailable"),
      ).toBeNull();
      expect(mocks.activity).not.toHaveBeenCalled();
      expect(screen.getByText("release-1")).toBeDefined();
      if (!mobile) {
        expect(screen.getAllByRole("columnheader")).toHaveLength(10);
      }
    },
  );
  it("explains launched beside release insights", async () => {
    render(<BundlesPage />);
    fireEvent.click(
      screen.getByRole("button", { name: "About release insight metrics" }),
    );
    expect((await screen.findByRole("tooltip")).textContent).toContain(
      "Launched: ran it.",
    );
  });
  it("keeps bundle management usable when activity is unavailable", () => {
    mocks.activity.mockReturnValue({ error: new Error("Offline") });
    render(<BundlesPage />);
    expect(screen.getByLabelText("Release insights unavailable")).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Open details for ID release-1" }),
    ).toBeDefined();
  });
  beforeEach(() => {
    mocks.activity.mockReturnValue({
      data: {
        "release-1": {
          downloads: 107,
          launched: 98,
          failedLaunches: 2,
          measuredAtMs: Date.UTC(2026, 6, 19),
        },
      },
    });
    releases = [release];
    entries = null;
    mocks.releasesQuery.mockImplementation(() => ({
      data: {
        entries:
          entries ?? releases.map((row) => ({ kind: "row" as const, row })),
      },
      error: null,
      isError: false,
      isPending: false,
    }));
    mocks.foldQuery.mockImplementation(() => ({
      data: undefined,
      isError: false,
      isPending: true,
    }));
    mocks.isMobile.mockReturnValue(false);
    mocks.search.mockReturnValue({});
    mocks.insightsAnalytics = true;
    release.currentlyUnreachable = false;
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("opens the Bundle edit sheet from the whole table row", () => {
    render(<BundlesPage />);
    const row = screen.getByRole("row", {
      name: "Open bundle release-1",
    });

    fireEvent.click(row);

    expect(mocks.navigate).toHaveBeenCalledWith({
      resetScroll: false,
      search: { releaseId: "release-1" },
      to: "/",
    });

    mocks.navigate.mockClear();
    fireEvent.keyDown(row, { key: "Enter" });

    expect(mocks.navigate).toHaveBeenCalledWith({
      resetScroll: false,
      search: { releaseId: "release-1" },
      to: "/",
    });
  });

  it("opens a Bundle from anywhere on its mobile card, except the card's controls", () => {
    mocks.isMobile.mockReturnValue(true);
    render(<BundlesPage />);
    const card = screen.getByRole("article", { name: "Bundle release-1" });

    fireEvent.click(within(card).getByText("Stable release"));

    expect(mocks.navigate).toHaveBeenCalledWith({
      resetScroll: false,
      search: { releaseId: "release-1" },
      to: "/",
    });

    mocks.navigate.mockClear();
    const insights = within(card).getByRole("link", {
      name: /Downloaded 107 Launched 98 Crashed 2/,
    });
    // jsdom can't follow a link; the card must still leave it alone.
    insights.addEventListener("click", (event) => event.preventDefault());
    fireEvent.click(insights);
    fireEvent.click(
      within(card).getByRole("button", {
        name: "Show advanced artifact diagnostics",
      }),
    );

    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(screen.getByText("Advanced artifact diagnostics")).toBeDefined();
  });

  it("keeps a default Bundle row focused on delivery decisions", () => {
    render(<BundlesPage />);
    const row = screen.getByRole("row", {
      name: "Open bundle release-1",
    });

    expect(within(row).getByText("release-1")).toBeDefined();
    expect(
      within(row).getByText(
        "e2e-job-20260812132427-qy22fi-android-s2-production",
      ),
    ).toBeDefined();
    expect(within(row).getByText("iOS")).toBeDefined();
    expect(within(row).getByText("1.2.x")).toBeDefined();
    expect(within(row).getByText("Enabled")).toBeDefined();
    expect(within(row).getByText("Optional")).toBeDefined();
    expect(within(row).getByText("100.0%").className).toContain("bg-primary");
    expect(within(row).queryByText("DEPLOY")).toBeNull();
    expect(within(row).queryByText("rev 1")).toBeNull();
  });

  it("subdues a Bundle that no catalog path currently selects first, and says why on a tap or focus", async () => {
    release.currentlyUnreachable = true;

    render(<BundlesPage />);
    const row = screen.getByRole("row", {
      name: "Open bundle release-1",
    });
    const state = within(row).getByRole("button", { name: /^Unreachable/ });

    expect(row.className).toContain("bg-muted/60");
    expect(row.className).toContain("saturate-50");
    expect(row.className).toContain("hover:saturate-100");
    expect(row.className).toContain("motion-reduce:transition-none");
    expect(state.textContent).toBe("Unreachable");
    // Not a hover-only title: a touch or a keyboard reaches the reason.
    expect(state.hasAttribute("title")).toBe(false);
    fireEvent.click(state);
    expect((await screen.findByRole("tooltip")).textContent).toBe(
      "No device gets this bundle with the current delivery settings.",
    );
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it("expands the base-to-patch relationship from the Bundle row", () => {
    render(<BundlesPage />);
    const row = screen.getByRole("row", {
      name: "Open bundle release-1",
    });

    expect(screen.queryByText("Base artifact ID")).toBeNull();
    fireEvent.click(
      within(row).getByRole("button", {
        name: "Show advanced artifact diagnostics",
      }),
    );

    expect(screen.getByText("Advanced artifact diagnostics")).toBeDefined();
    expect(screen.getByText("Base artifact ID")).toBeDefined();
    expect(screen.getByText("Patch artifacts from this base")).toBeDefined();
    expect(screen.getAllByText(childBundle.id).length).toBeGreaterThan(0);
    expect(screen.getByText("bsdiff")).toBeDefined();
    expect(
      within(row).getByRole("button", {
        name: "Hide advanced artifact diagnostics",
      }),
    ).toBeDefined();
  });

  it.each([false, true])(
    "distinguishes promoted updates sharing one file (mobile: %s)",
    (mobile) => {
      mocks.isMobile.mockReturnValue(mobile);
      releases = [
        release,
        { ...release, id: "release-2", operation: "PROMOTE" },
      ];
      render(<BundlesPage />);

      expect(screen.getByRole("heading", { name: "Bundles" })).toBeDefined();
      expect(
        screen.getByRole("navigation", { name: "Bundle pagination" }),
      ).toBeDefined();
      expect(screen.queryByText(release.bundle_id!)).toBeNull();
      for (const id of ["release-1", "release-2"]) {
        expect(screen.getByText(id)).toBeDefined();
        fireEvent.click(
          screen.getByRole("button", { name: `Open details for ID ${id}` }),
        );
        expect(mocks.navigate).toHaveBeenLastCalledWith({
          resetScroll: false,
          search: { releaseId: id },
          to: "/",
        });
      }
    },
  );

  it("filters by the sets the release indexes serve and pages by key", () => {
    render(<BundlesPage />);

    // Target versions filter only through a scope.
    expect(screen.queryByLabelText("Target app version")).toBeNull();
    expect(
      screen.getByText((_, node) =>
        Boolean(node?.textContent === "1 bundle, newest first"),
      ),
    ).toBeDefined();
    expect(screen.queryByText(/^Page /)).toBeNull();
    expect(
      screen.getByRole("button", { name: "Next" }).hasAttribute("disabled"),
    ).toBe(true);
  });

  it.each([false, true])(
    "says what fills an empty list, as Native builds does (mobile: %s)",
    (mobile) => {
      mocks.isMobile.mockReturnValue(mobile);
      releases = [];

      mocks.search.mockReturnValue({ bundleId: "missing" });
      const { unmount } = render(<BundlesPage />);
      expect(screen.getByText("No bundles match these filters")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
      expect(mocks.navigate).toHaveBeenCalledWith({
        resetScroll: true,
        search: {},
        to: "/",
      });
      unmount();

      mocks.search.mockReturnValue({ beforeReleaseId: "release-9" });
      const later = render(<BundlesPage />);
      expect(screen.getByText("No more bundles")).toBeTruthy();
      expect(
        screen.getByRole("link", { name: "Show the newest bundles" }),
      ).toBeTruthy();
      later.unmount();

      mocks.search.mockReturnValue({});
      render(<BundlesPage />);
      expect(screen.getByText("No bundles yet")).toBeTruthy();
      expect(screen.getByText("npx hot-updater deploy")).toBeTruthy();
    },
  );

  it.each([false, true])(
    "shows when a bundle was created relative to now, the exact time on hover (mobile: %s)",
    (mobile) => {
      mocks.isMobile.mockReturnValue(mobile);
      render(<BundlesPage />);

      const created = document.querySelector("time")!;
      expect(created.textContent).toMatch(/ ago/);
      expect(created.getAttribute("title")).toMatch(
        /^2026-07-1[78] \d{2}:\d{2}:\d{2}$/,
      );
    },
  );

  it("shows a bundle as a compact card, as Native builds does: what and where, then delivery, insights, and message", () => {
    mocks.isMobile.mockReturnValue(true);
    render(<BundlesPage />);
    const card = screen.getByRole("article", { name: "Bundle release-1" });

    // No label-value boxes: lines of values, a few cards to a screen.
    expect(card.querySelector(":scope > dl")).toBeNull();
    const meta = card.children[1]!;
    expect(meta.textContent).toMatch(/^iOS·1 patch·.+ ago$/);
    const delivery = card.children[2]!;
    expect(delivery.textContent).toContain("Target 1.2.x");
    expect(
      within(card).getByRole("link", { name: /Downloaded 107 Launched 98/ }),
    ).toBeTruthy();
    expect(card.lastElementChild!.textContent).toBe("Stable release");
  });

  it("shows a card's fingerprint target as the table's pill", () => {
    mocks.isMobile.mockReturnValue(true);
    const fingerprint = "e7b2a84d0123456789abcdef0123456789ab9efb";
    releases = [
      {
        ...release,
        strategy: "FINGERPRINT",
        target_app_version: null,
        fingerprint_hash: fingerprint,
      },
    ];
    render(<BundlesPage />);

    expect(
      screen.getByRole("button", { name: `Copy full value: ${fingerprint}` })
        .textContent,
    ).toBe("e7b2a84d…9efb");
  });

  describe("unreachable bundles, folded where they sit", () => {
    const at = (id: string, currentlyUnreachable: boolean) => ({
      ...release,
      id,
      currentlyUnreachable,
    });
    const r = {
      5: at("release-5", false),
      4: at("release-4", true),
      3: at("release-3", false),
      2: at("release-2", true),
      1: at("release-1", true),
    };
    const row = (n: keyof typeof r) => ({ kind: "row" as const, row: r[n] });
    const fold = (from: string | undefined, to: string, count: number) => ({
      kind: "fold" as const,
      count,
      more: false,
      ...(from === undefined ? {} : { from }),
      to,
    });
    // As the server pages them: 5 and 3 reachable, 4 and 2..1 folded.
    const page = [
      row(5),
      fold("release-5", "release-4", 1),
      row(3),
      fold("release-3", "release-1", 2),
    ];
    /** The fold under `from` answers these rows once it opens. */
    const foldAnswers = (answers: Record<string, ReleaseListRow[]>) =>
      mocks.foldQuery.mockImplementation(
        (_filter: unknown, bounds: { from?: string }, enabled: boolean) =>
          enabled && answers[bounds.from ?? ""] !== undefined
            ? {
                data: { pages: [{ rows: answers[bounds.from ?? ""] }] },
                isError: false,
                isPending: false,
                isFetchingNextPage: false,
                hasNextPage: false,
              }
            : { data: undefined, isError: false, isPending: true },
      );
    const rowNames = () =>
      screen
        .getAllByRole("row")
        .slice(1)
        .map((tr) => tr.getAttribute("aria-label") ?? tr.textContent);
    const LINEAGE = "Advanced artifact diagnostics";

    beforeEach(() => {
      entries = page;
      foldAnswers({ "release-3": [r[2], r[1]] });
    });

    it("keeps the list's order, each run of unreachable bundles one closed fold where it sits", () => {
      render(<BundlesPage />);

      expect(rowNames()).toEqual([
        "Open bundle release-5",
        "1 unreachable bundle",
        "Open bundle release-3",
        "2 unreachable bundles",
      ]);
      for (const name of ["1 unreachable bundle", "2 unreachable bundles"]) {
        const button = screen.getByRole("button", { name });
        expect(button.getAttribute("aria-expanded")).toBe("false");
        const panel = document.getElementById(
          button.getAttribute("aria-controls")!,
        );
        expect(panel?.tagName).toBe("TBODY");
        expect(panel?.hidden).toBe(true);
      }
      expect(
        mocks.foldQuery.mock.calls.every(([, , enabled]) => enabled === false),
      ).toBe(true);
      // The pager counts the reachable rows, and what its folds hold.
      expect(
        screen
          .getByRole("navigation", { name: "Bundle pagination" })
          .querySelector("p")?.textContent,
      ).toBe("2 bundles, newest first · , 3 unreachable folded");
    });

    it("opens one fold in place: exactly its range, its bundles subdued, saying why by tap or focus", async () => {
      render(<BundlesPage />);
      fireEvent.click(
        screen.getByRole("button", { name: "2 unreachable bundles" }),
      );

      expect(mocks.foldQuery).toHaveBeenCalledWith(
        { kind: "all" },
        { from: "release-3", to: "release-1" },
        true,
      );
      expect(rowNames()).toEqual([
        "Open bundle release-5",
        "1 unreachable bundle",
        "Open bundle release-3",
        "2 unreachable bundles",
        "Open bundle release-2",
        "Open bundle release-1",
      ]);
      const subdued = screen.getByRole("row", {
        name: "Open bundle release-2",
      });
      expect(subdued.className).toContain("bg-muted/60");
      const reason = within(subdued).getByRole("button", {
        name: /^Unreachable/,
      });
      // Not a hover-only title: a touch or a keyboard reaches the reason.
      expect(reason.hasAttribute("title")).toBe(false);
      fireEvent.click(reason);
      expect((await screen.findByRole("tooltip")).textContent).toBe(
        "No device gets this bundle with the current delivery settings.",
      );
      expect(mocks.navigate).not.toHaveBeenCalled();
    });

    it("asks the page's read to keep the selected bundle out of every fold, so a link to it shows its row", () => {
      mocks.search.mockReturnValue({ releaseId: "release-2" });
      // The server keeps it as a row, splitting its run around it.
      entries = [
        row(5),
        fold("release-5", "release-4", 1),
        row(3),
        row(2),
        fold("release-2", "release-1", 1),
      ];
      render(<BundlesPage />);

      expect(mocks.releasesQuery).toHaveBeenCalledWith(
        expect.objectContaining({ releaseId: "release-2" }),
      );
      const selected = screen.getByRole("row", {
        name: "Open bundle release-2",
      });
      expect(selected.getAttribute("data-state")).toBe("selected");
      expect(rowNames()).toEqual([
        "Open bundle release-5",
        "1 unreachable bundle",
        "Open bundle release-3",
        "Open bundle release-2",
        "1 unreachable bundle",
      ]);
    });

    it("keeps a selected bundle and its lineage while folds open and close", () => {
      mocks.search.mockReturnValue({ releaseId: "release-2" });
      entries = [
        row(5),
        fold("release-5", "release-4", 1),
        row(3),
        row(2),
        fold("release-2", "release-1", 1),
      ];
      render(<BundlesPage />);
      fireEvent.click(
        within(
          screen.getByRole("row", { name: "Open bundle release-2" }),
        ).getByRole("button", { name: "Show advanced artifact diagnostics" }),
      );
      expect(screen.getByText(LINEAGE)).toBeDefined();

      for (const name of ["1 unreachable bundle"]) {
        const [first] = screen.getAllByRole("button", { name });
        fireEvent.click(first!);
        fireEvent.click(first!);
      }
      expect(
        screen.getByRole("row", { name: "Open bundle release-2" }),
      ).toBeDefined();
      expect(screen.getByText(LINEAGE)).toBeDefined();
    });

    it("closes a lineage panel whose row a fold hides, by a click, and opening the fold brings none back", () => {
      render(<BundlesPage />);
      const toggle = () =>
        fireEvent.click(
          screen.getByRole("button", { name: "2 unreachable bundles" }),
        );
      toggle();
      fireEvent.click(
        within(
          screen.getByRole("row", { name: "Open bundle release-2" }),
        ).getByRole("button", { name: "Show advanced artifact diagnostics" }),
      );
      expect(screen.getByText(LINEAGE)).toBeDefined();

      toggle();
      expect(screen.queryByText(LINEAGE)).toBeNull();
      toggle();
      expect(
        screen.getByRole("row", { name: "Open bundle release-2" }),
      ).toBeDefined();
      expect(screen.queryByText(LINEAGE)).toBeNull();
    });

    it("closes a lineage panel whose row the URL folds, by Back, and Forward brings none back", () => {
      // Selected: the server keeps release-2 as a row.
      const selected = [
        row(5),
        fold("release-5", "release-4", 1),
        row(3),
        row(2),
        fold("release-2", "release-1", 1),
      ];
      mocks.search.mockReturnValue({ releaseId: "release-2" });
      entries = selected;
      const { rerender } = render(<BundlesPage />);
      fireEvent.click(
        within(
          screen.getByRole("row", { name: "Open bundle release-2" }),
        ).getByRole("button", { name: "Show advanced artifact diagnostics" }),
      );
      expect(screen.getByText(LINEAGE)).toBeDefined();

      // Back: no selection, so release-2 folds again; no click on any fold.
      mocks.search.mockReturnValue({});
      entries = page;
      rerender(<BundlesPage />);
      expect(screen.queryByText(LINEAGE)).toBeNull();

      // Forward: the row is back, its panel isn't.
      mocks.search.mockReturnValue({ releaseId: "release-2" });
      entries = selected;
      rerender(<BundlesPage />);
      expect(
        screen.getByRole("row", { name: "Open bundle release-2" }),
      ).toBeDefined();
      expect(screen.queryByText(LINEAGE)).toBeNull();
    });

    it("keeps the rows under a bundle selected in an open fold open, when the selection splits the fold", () => {
      const { rerender } = render(<BundlesPage />);
      fireEvent.click(
        screen.getByRole("button", { name: "2 unreachable bundles" }),
      );
      fireEvent.click(
        screen.getByRole("button", { name: "Open details for ID release-2" }),
      );
      expect(mocks.navigate).toHaveBeenLastCalledWith({
        resetScroll: false,
        search: { releaseId: "release-2" },
        to: "/",
      });

      // The server splits the fold around the selected bundle.
      mocks.search.mockReturnValue({ releaseId: "release-2" });
      entries = [
        row(5),
        fold("release-5", "release-4", 1),
        row(3),
        row(2),
        fold("release-2", "release-1", 1),
      ];
      foldAnswers({ "release-2": [r[1]] });
      rerender(<BundlesPage />);

      expect(rowNames()).toEqual([
        "Open bundle release-5",
        "1 unreachable bundle",
        "Open bundle release-3",
        "Open bundle release-2",
        "1 unreachable bundle",
        "Open bundle release-1",
      ]);
    });

    it("shows a page of unreachable bundles alone as one fold under the empty state", () => {
      entries = [fold(undefined, "release-1", 3)];
      render(<BundlesPage />);

      expect(screen.getByText("No device gets the bundles here")).toBeTruthy();
      expect(
        screen.getByRole("button", { name: "3 unreachable bundles" }),
      ).toBeTruthy();
    });

    it("folds the cards on a phone the same way, in place", () => {
      mocks.isMobile.mockReturnValue(true);
      render(<BundlesPage />);

      const cards = () =>
        screen
          .getAllByRole("article")
          .map((card) => card.getAttribute("aria-label"));
      expect(cards()).toEqual(["Bundle release-5", "Bundle release-3"]);
      const button = screen.getByRole("button", {
        name: "2 unreachable bundles",
      });
      expect(
        document.getElementById(button.getAttribute("aria-controls")!),
      ).not.toBeNull();
      fireEvent.click(button);
      expect(cards()).toEqual([
        "Bundle release-5",
        "Bundle release-3",
        "Bundle release-2",
        "Bundle release-1",
      ]);
    });
  });
});
