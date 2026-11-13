import type { NativeBuildRow } from "@hot-updater/plugin-core";
import { encodeChannelKey } from "@hot-updater/protocol";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { NativeBuildDetail } from "@/lib/server/nativeBuilds";

import { NativeBuildDetailPage } from "./NativeBuildDetailPage";

const { detailQuery, installCards } = vi.hoisted(() => ({
  detailQuery: vi.fn(),
  /** Each Install card mounted, by its build and sibling. */
  installCards: [] as { build: string; sibling: string | null }[],
}));

vi.mock("@/lib/api", () => ({
  useNativeBuildDetailQuery: detailQuery,
}));
vi.mock("@/components/ui/sidebar", () => ({
  SidebarTrigger: () => null,
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, search }: { children: ReactNode; search?: unknown }) => (
    <span data-search={JSON.stringify(search ?? null)}>{children}</span>
  ),
}));
// The header is under test; the cards have their own specs.
vi.mock("./BuiltInBundleCard", () => ({ BuiltInBundleCard: () => null }));
vi.mock("./InstallCard", async () => {
  const { useState } = await import("react");
  return {
    InstallCard: ({
      build,
      sibling,
    }: {
      build: NativeBuildRow;
      sibling: NativeBuildRow | null;
    }) => {
      // Runs once a mount, as the card's own state starts.
      useState(() =>
        installCards.push({ build: build.id, sibling: sibling?.id ?? null }),
      );
      return null;
    },
  };
});
vi.mock("./IpaDevicesCard", () => ({
  IpaDevicesCard: () => <p>Devices in this build</p>,
}));
vi.mock("./PatchesCard", () => ({ PatchesCard: () => null }));
vi.mock("./ServedNowCard", () => ({ ServedNowCard: () => null }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  installCards.length = 0;
});

const build = (overrides: Partial<NativeBuildRow>): NativeBuildRow => ({
  id: "019a0000-0000-7000-8000-000000000001",
  scope_key: "scope",
  platform: "ios",
  channel_id: `channel:${encodeChannelKey("pr-130")}`,
  fingerprint_hash: "1a2b3c4d5e6f7a8b9c0d",
  app_version: null,
  min_bundle_id: "019a0000-0000-7000-8000-000000000002",
  artifact_kind: "ipa",
  artifact_storage_uri: "r2://bucket/native-builds/ios/019a/App.ipa",
  byte_size: 52_428_800,
  git_commit_hash: null,
  created_at_ms: 0,
  build_key: null,
  build_number: null,
  submitted_to: null,
  submitted_at_ms: null,
  submitted_version: null,
  is_store_build: false,
  is_sandbox: false,
  sandbox_url_scheme: null,
  export_method: null,
  ...overrides,
});

const detailOf = (
  row: NativeBuildRow,
  channel: string,
  sibling: NativeBuildRow | null = null,
) =>
  ({
    build: row,
    channel,
    catalogScopeKey: "scope",
    builtInBundle: { childCount: 0 },
    newestInScope: row,
    storeBuildInScope: null,
    servedNow: [],
    patches: { data: [] },
    sibling,
  }) satisfies NativeBuildDetail;

const show = (row: NativeBuildRow, channel: string) => {
  detailQuery.mockReturnValue({
    data: detailOf(row, channel),
    isError: false,
  });
  render(
    <NativeBuildDetailPage
      buildId={row.id}
      onSearchChange={vi.fn()}
      search={{}}
    />,
  );
  return screen.getByRole("heading", { level: 1 });
};

describe("NativeBuildDetailPage", () => {
  it("hands the Install card the sibling, and starts it afresh on the sibling's page", () => {
    const ipa = build({ is_sandbox: true, export_method: "ad-hoc" });
    const app = build({
      id: "019a0000-0000-7000-8000-000000000009",
      artifact_kind: "app",
      is_sandbox: true,
    });
    detailQuery.mockReturnValue({
      data: detailOf(ipa, "pr-130", app),
      isError: false,
    });
    const page = render(
      <NativeBuildDetailPage
        buildId={ipa.id}
        onSearchChange={vi.fn()}
        search={{}}
      />,
    );
    detailQuery.mockReturnValue({
      data: detailOf(app, "pr-131", ipa),
      isError: false,
    });
    page.rerender(
      <NativeBuildDetailPage
        buildId={app.id}
        onSearchChange={vi.fn()}
        search={{}}
      />,
    );

    // While the sibling's page loads, no card is shown, so no segment of
    // the build left behind stays marked as the current one.
    detailQuery.mockReturnValue({ data: undefined, isError: false });
    page.rerender(
      <NativeBuildDetailPage
        buildId="019a0000-0000-7000-8000-000000000008"
        onSearchChange={vi.fn()}
        search={{}}
      />,
    );
    expect(screen.getByText("Loading the native build")).toBeTruthy();
    expect(installCards).toHaveLength(2);
    // The route keeps the page mounted; the card's state is the build's own.
    expect(installCards).toEqual([
      { build: ipa.id, sibling: app.id },
      { build: app.id, sibling: ipa.id },
    ]);
  });

  it("tags a sandbox build in its title, beside its kind and before its channel", () => {
    const title = show(build({ is_sandbox: true }), "pr-130");
    expect(title.textContent).toMatch(/^iOS IPA\s*Sandbox\s*·\s*pr-130/);
  });

  it("goes back to the list of the build's own channel, where its row is", () => {
    show(build({ is_sandbox: true }), "pr-128");
    expect(
      screen
        .getByText("Native builds")
        .closest("[data-search]")!
        .getAttribute("data-search"),
    ).toBe(JSON.stringify({ channel: "pr-128" }));
  });

  it.each([
    ["loads", { data: undefined, isError: false, isPending: true }],
    [
      "can't be read",
      {
        data: undefined,
        error: new Error("Offline"),
        isError: true,
        isPending: false,
        refetch: vi.fn(),
      },
    ],
    ["isn't found", { data: null, isError: false, isPending: false }],
  ])(
    "goes back to every channel's list while the build %s, so a build of any channel is there",
    (_, state) => {
      detailQuery.mockReturnValue(state);
      render(
        <NativeBuildDetailPage
          buildId="019a0000-0000-7000-8000-000000000009"
          onSearchChange={vi.fn()}
          search={{}}
        />,
      );
      expect(
        screen
          .getByText("Native builds")
          .closest("[data-search]")!
          .getAttribute("data-search"),
      ).toBe(JSON.stringify({ channels: "all" }));
    },
  );

  it("tags no build its record doesn't call a sandbox build, whatever its channel", () => {
    const title = show(build({}), "pr-128");
    expect(title.textContent).not.toMatch(/Sandbox/);
    expect(title.textContent).toContain("pr-128");
  });

  it("says a build it can't find may be deleted, naming no command", () => {
    detailQuery.mockReturnValue({ data: null, isError: false });
    render(
      <NativeBuildDetailPage
        buildId="019a0000-0000-7000-8000-000000000009"
        onSearchChange={vi.fn()}
        search={{}}
      />,
    );
    expect(screen.getByText("Native build not found")).toBeTruthy();
    expect(screen.queryByText(/native-build delete/)).toBeNull();
    expect(
      screen.getByText(
        /It may have been deleted, or be from another console\./,
      ),
    ).toBeTruthy();
    // The list opens on production unless told otherwise.
    expect(
      screen.getByText("Show all native builds").getAttribute("data-search"),
    ).toBe(JSON.stringify({ channels: "all" }));
  });

  it("lists an ad hoc IPA's devices, and reads nothing more for a store's IPA or another artifact", () => {
    show(build({}), "pr-130");
    expect(screen.getByText("Devices in this build")).toBeTruthy();
    cleanup();
    show(
      build({ submitted_to: "testflight", submitted_at_ms: 1 }),
      "production",
    );
    expect(screen.queryByText("Devices in this build")).toBeNull();
    cleanup();
    show(build({ artifact_kind: "app" }), "pr-130");
    expect(screen.queryByText("Devices in this build")).toBeNull();
  });
});
