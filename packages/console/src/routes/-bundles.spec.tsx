import type { ReleaseRow } from "@hot-updater/plugin-core";
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
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));

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

vi.mock("@/lib/api", () => ({
  useBundleChildCountsQuery: () => ({
    data: { "019ff641-01eb-72ea-8a03-a28aef188d32": 0 },
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
      data: [release],
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
      name: "Open bundle 019ff641-01eb-72ea-8a03-a28aef188d32",
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
      name: "Open bundle 019ff641-01eb-72ea-8a03-a28aef188d32",
    });

    expect(
      within(row).getByText("019ff641-01eb-72ea-8a03-a28aef188d32"),
    ).toBeDefined();
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

  it("subdues a Release that no catalog path currently selects first", () => {
    release.currentlyUnreachable = true;

    render(<BundlesPage />);
    const row = screen.getByRole("row", {
      name: "Open bundle 019ff641-01eb-72ea-8a03-a28aef188d32",
    });
    const state = within(row).getByText("Unreachable");

    expect(row.className).toContain("bg-muted/35");
    expect(state.getAttribute("title")).toBe(
      "No catalog segment or cohort selects this release first with the current delivery settings.",
    );
  });

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
