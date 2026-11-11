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
  useReleasesQuery: () => ({
    data: { data: releases },
    error: null,
    isError: false,
    isPending: false,
  }),
}));

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

    expect(row.className).toContain("bg-muted/35");
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
        Boolean(node?.textContent === "1 entry, newest first"),
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

  describe("unreachable bundles", () => {
    const at = (id: string, currentlyUnreachable: boolean) => ({
      ...release,
      id,
      currentlyUnreachable,
    });
    const rowNames = () =>
      screen
        .getAllByRole("row")
        .slice(1)
        .map((row) => row.getAttribute("aria-label") ?? row.textContent);
    const GROUP = "2 unreachable bundles on this page";

    beforeEach(() => {
      releases = [
        at("release-3", false),
        at("release-2", true),
        at("release-1", true),
      ];
    });

    it("collapses a page's unreachable bundles under one closed group", () => {
      render(<BundlesPage />);

      expect(rowNames()).toEqual(["Open bundle release-3", GROUP]);
      const group = screen.getByRole("button", { name: GROUP });
      expect(group.getAttribute("aria-expanded")).toBe("false");
      expect(group.hasAttribute("aria-controls")).toBe(false);
      fireEvent.click(group);
      expect(mocks.navigate).toHaveBeenCalledWith({
        resetScroll: false,
        search: { showUnreachable: true },
        to: "/",
      });
      // The pager counts the whole page, collapsed or not.
      expect(
        screen.getByText((_, node) =>
          Boolean(node?.textContent === "3 entries, newest first"),
        ),
      ).toBeDefined();
    });

    it("opens the group from the URL, its bundles still subdued, and closes it", () => {
      mocks.search.mockReturnValue({ showUnreachable: true });
      render(<BundlesPage />);

      expect(rowNames()).toEqual([
        "Open bundle release-3",
        GROUP,
        "Open bundle release-2",
        "Open bundle release-1",
      ]);
      expect(
        screen.getByRole("row", { name: "Open bundle release-2" }).className,
      ).toContain("bg-muted/35");
      fireEvent.click(screen.getByRole("button", { name: GROUP }));
      expect(mocks.navigate).toHaveBeenCalledWith({
        resetScroll: false,
        search: { showUnreachable: undefined },
        to: "/",
      });
    });

    it("keeps a selected unreachable bundle in place, out of the group", () => {
      mocks.search.mockReturnValue({ releaseId: "release-2" });
      render(<BundlesPage />);

      expect(rowNames()).toEqual([
        "Open bundle release-3",
        "Open bundle release-2",
        "1 unreachable bundle on this page",
      ]);
      expect(
        screen
          .getByRole("row", { name: "Open bundle release-2" })
          .getAttribute("data-state"),
      ).toBe("selected");
    });

    it.each([
      { channelId: "channel-1", platform: "ios", enabled: false },
      { bundleId: release.bundle_id },
    ])("shows every bundle a filter asks for, subdued (%o)", (search) => {
      mocks.search.mockReturnValue(search);
      render(<BundlesPage />);

      expect(rowNames()).toEqual([
        "Open bundle release-3",
        "Open bundle release-2",
        "Open bundle release-1",
      ]);
      expect(screen.getAllByText("Unreachable")).toHaveLength(2);
    });

    it("shows a page of only unreachable bundles without the group", () => {
      releases = [at("release-2", true), at("release-1", true)];
      render(<BundlesPage />);

      expect(rowNames()).toEqual([
        "Open bundle release-2",
        "Open bundle release-1",
      ]);
      expect(screen.queryByRole("button", { name: /unreachable/ })).toBeNull();
    });

    it("closes a collapsed bundle's lineage with the group", () => {
      mocks.search.mockReturnValue({ showUnreachable: true });
      const { rerender } = render(<BundlesPage />);
      fireEvent.click(
        within(
          screen.getByRole("row", { name: "Open bundle release-2" }),
        ).getByRole("button", { name: "Show advanced artifact diagnostics" }),
      );
      expect(screen.getByText("Advanced artifact diagnostics")).toBeDefined();

      fireEvent.click(screen.getByRole("button", { name: GROUP }));
      mocks.search.mockReturnValue({});
      rerender(<BundlesPage />);
      expect(screen.queryByText("Advanced artifact diagnostics")).toBeNull();
      // Opening the group again opens no lineage on its own.
      mocks.search.mockReturnValue({ showUnreachable: true });
      rerender(<BundlesPage />);
      expect(screen.queryByText("Advanced artifact diagnostics")).toBeNull();
    });

    it("keeps the group open when filters clear", () => {
      releases = [];
      mocks.search.mockReturnValue({
        bundleId: "missing",
        showUnreachable: true,
      });
      render(<BundlesPage />);

      fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
      expect(mocks.navigate).toHaveBeenCalledWith({
        resetScroll: true,
        search: { showUnreachable: true },
        to: "/",
      });
    });

    it("collapses the unreachable cards on a phone the same way", () => {
      mocks.isMobile.mockReturnValue(true);
      render(<BundlesPage />);

      expect(
        screen
          .getAllByRole("article")
          .map((card) => card.getAttribute("aria-label")),
      ).toEqual(["Bundle release-3"]);
      const group = screen.getByRole("button", { name: GROUP });
      expect(group.getAttribute("aria-expanded")).toBe("false");
      fireEvent.click(group);
      expect(mocks.navigate).toHaveBeenCalledWith({
        resetScroll: false,
        search: { showUnreachable: true },
        to: "/",
      });
    });
  });
});
