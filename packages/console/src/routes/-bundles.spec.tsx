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
  navigate: vi.fn(),
  search: vi.fn(),
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
      activity30d: { installed: 1, recovered: 0 },
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
    data: {
      data: releases,
      pagination: {
        currentPage: 1,
        hasNextPage: false,
        hasPreviousPage: false,
      },
    },
    error: null,
    isError: false,
    isPending: false,
  }),
}));

import { Route } from "./index";

const BundlesPage = (Route as unknown as { readonly component: ComponentType })
  .component;

describe("BundlesPage", () => {
  beforeEach(() => {
    releases = [release];
    mocks.isMobile.mockReturnValue(false);
    mocks.search.mockReturnValue({});
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
    const movement = within(row).getByRole("group", {
      name: "Bundle movement over 30 days, distinct installations",
    });
    expect(within(movement).getByText("Applied")).toBeDefined();
    expect(within(movement).getByText("1")).toBeDefined();
    expect(within(movement).getByText("Recovered")).toBeDefined();
    expect(within(movement).getByText("0")).toBeDefined();
    expect(within(row).queryByText("DEPLOY")).toBeNull();
    expect(within(row).queryByText("rev 1")).toBeNull();
  });

  it("subdues a Bundle that no catalog path currently selects first", () => {
    release.currentlyUnreachable = true;

    render(<BundlesPage />);
    const row = screen.getByRole("row", {
      name: "Open bundle release-1",
    });
    const state = within(row).getByText("Unreachable");

    expect(row.className).toContain("bg-muted/35");
    expect(row.className).toContain("saturate-50");
    expect(row.className).toContain("hover:saturate-100");
    expect(row.className).toContain("motion-reduce:transition-none");
    expect(state.getAttribute("title")).toBe(
      "No catalog segment or cohort selects this bundle first with the current delivery settings.",
    );
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

  it("keeps the main Console filters and pagination summary", () => {
    render(<BundlesPage />);

    const targetAppVersion = screen.getByLabelText("Target app version");
    fireEvent.change(targetAppVersion, { target: { value: "1.2.x" } });
    fireEvent.keyDown(targetAppVersion, { key: "Enter" });

    expect(mocks.navigate).toHaveBeenCalledWith({
      resetScroll: true,
      search: { targetAppVersion: "1.2.x" },
      to: "/",
    });
    expect(
      screen.getByText((_, node) =>
        Boolean(node?.textContent === "Showing 1 to 1 entries"),
      ),
    ).toBeDefined();
    expect(
      screen.getByText((_, node) => Boolean(node?.textContent === "Page 1")),
    ).toBeDefined();
  });
});
