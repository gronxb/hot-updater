import type { NativeBuildRow } from "@hot-updater/plugin-core";
import { encodeChannelKey } from "@hot-updater/protocol";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { NativeBuildDetail } from "@/lib/server/nativeBuilds";

import { NativeBuildDetailPage } from "./NativeBuildDetailPage";

const { detailQuery } = vi.hoisted(() => ({ detailQuery: vi.fn() }));

vi.mock("@/lib/api", () => ({
  useNativeBuildDetailQuery: detailQuery,
}));
vi.mock("@/components/ui/sidebar", () => ({
  SidebarTrigger: () => null,
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
// The header is under test; the cards have their own specs.
vi.mock("./BuiltInBundleCard", () => ({ BuiltInBundleCard: () => null }));
vi.mock("./InstallCard", () => ({ InstallCard: () => null }));
vi.mock("./IpaDevicesCard", () => ({
  IpaDevicesCard: () => <p>Devices in this build</p>,
}));
vi.mock("./PatchesCard", () => ({ PatchesCard: () => null }));
vi.mock("./ServedNowCard", () => ({ ServedNowCard: () => null }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
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
  ...overrides,
});

const show = (row: NativeBuildRow, channel: string) => {
  detailQuery.mockReturnValue({
    data: {
      build: row,
      channel,
      catalogScopeKey: "scope",
      builtInBundle: { childCount: 0 },
      newestInScope: row,
      storeBuildInScope: null,
      servedNow: [],
      patches: { data: [] },
    } satisfies NativeBuildDetail,
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
  it("tags a sandbox build in its title, beside its kind and before its channel", () => {
    const title = show(build({ is_sandbox: true }), "pr-130");
    expect(title.textContent).toMatch(/^iOS IPA\s*Sandbox\s*·\s*pr-130/);
  });

  it("tags no build its record doesn't call a sandbox build, whatever its channel", () => {
    const title = show(build({}), "sandbox-release");
    expect(title.textContent).not.toMatch(/Sandbox/);
    expect(title.textContent).toContain("sandbox-release");
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
