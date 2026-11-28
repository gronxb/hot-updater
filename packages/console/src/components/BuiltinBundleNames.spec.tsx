import type { NativeBuildRow } from "@hot-updater/plugin-core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { getReleaseNativeBuild } from "@/lib/api-rpc";
import type { InsightsInstallationViewRow } from "@/lib/insights-view";
import { bundleChip } from "@/lib/release-adoption";
import type { NativeBuildDetail } from "@/lib/server/nativeBuilds";

import { ArtifactIdDisplay } from "./ArtifactIdDisplay";
import { EventBundleTransition } from "./features/insights/EventDetails";
import { InstallationHistoryCard } from "./features/insights/InstallationHistoryCard";
import { InstallationMatchesCard } from "./features/insights/InstallationMatchesCard";
import { BuiltInBundleCard } from "./features/native-builds/BuiltInBundleCard";
import { ReleaseNativeBuildLink } from "./features/native-builds/ReleaseNativeBuildLink";

vi.mock("@/lib/api-rpc", () => ({ getReleaseNativeBuild: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="/">{children}</a>,
}));

/*
 * A built-in bundle's ID tells people nothing: a native build makes it from
 * its build time and zero random bits, so its tail is zeros in every build,
 * and its head is a timestamp. The Console names it "Built-in bundle" with
 * the app version where the surface has one, the full ID in its popover.
 */
const ZERO_TAIL = "019f6a0e-77c1-7000-8000-000000000000";
// An earlier CLI's built-in bundle ID: a platform byte, then random bits.
const PLATFORM_BYTE = "019f6a0f-1b2c-7000-8000-01c4d2e8a7f3";
// A debug build's.
const NIL = "00000000-0000-0000-0000-000000000000";
// Any ID the report names as its `minBundleId`, whatever its shape.
const REPORTED_MIN = "019f6a10-5a5a-7b6b-8c7c-d8d8e9e9fafa";
const BUILT_INS = [ZERO_TAIL, PLATFORM_BYTE, NIL];

const RELEASE = "019f6a12-3c4d-7e5f-8a6b-7c8d9e0f1a2b";
const ARTIFACT = "019f6a13-9e8d-7c6b-a5f4-e3d2c1b0a9f8";
const TAIL = 12;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** The text a sighted user reads: no screen-reader text, no popover. */
const visibleText = (root: HTMLElement) => {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let text = "";
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.parentElement!.closest(".sr-only, [role=tooltip]")) continue;
    text += node.textContent ?? "";
  }
  return text.replace(/\s+/g, " ").trim();
};

/** Fails if any piece of `id` shows: its tail, its head, or its timestamp. */
const expectNoFragmentOf = (text: string, id: string) => {
  for (const piece of [id.slice(0, 8), id.slice(0, TAIL), id.slice(-TAIL)]) {
    expect(text, `${id} shows as "${piece}" in "${text}"`).not.toContain(piece);
  }
};

const withQueries = (ui: ReactElement) => (
  <QueryClientProvider
    client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
  >
    {ui}
  </QueryClientProvider>
);

describe("a built-in bundle is named, never shown by an ID fragment", () => {
  it.each(BUILT_INS)(
    "in an artifact's display of %s, copyable or not",
    (id) => {
      for (const copyable of [true, false]) {
        const { container } = render(
          <ArtifactIdDisplay artifactId={id} copyable={copyable} />,
        );
        const text = visibleText(container);
        expect(text).toBe("Built-in bundle");
        expectNoFragmentOf(text, id);
        cleanup();
      }
    },
  );

  it("keeps the full ID in its popover, and copies it", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<ArtifactIdDisplay artifactId={ZERO_TAIL} />);
    const button = screen.getByRole("button", {
      name: new RegExp(`Built-in bundle.*${ZERO_TAIL}`),
    });
    await act(async () => {
      fireEvent.click(button);
    });
    expect(writeText).toHaveBeenCalledWith(ZERO_TAIL);
    const popover = await screen.findByRole("tooltip");
    expect(within(popover).getByText("Built-in bundle ID")).toBeDefined();
    expect(within(popover).getByText(ZERO_TAIL)).toBeDefined();
  });

  it("still shows any other artifact ID as its last 12 characters", () => {
    const { container } = render(<ArtifactIdDisplay artifactId={ARTIFACT} />);
    expect(visibleText(container)).toBe(ARTIFACT);
    expect(container.querySelector("[class*='w-[12ch]']")!.className).toContain(
      "justify-end",
    );
  });

  it.each([...BUILT_INS, REPORTED_MIN])(
    "in an event's bundles, with the event's app version: %s",
    (id) => {
      const { container } = render(
        <EventBundleTransition
          event={{
            type: "RECOVERED",
            appVersion: "1.6.1",
            fromBundleId: ARTIFACT,
            fromReleaseId: RELEASE,
            toBundleId: id,
            toReleaseId: undefined,
            minBundleId: REPORTED_MIN,
          }}
        />,
      );
      const text = visibleText(container);
      expect(text).toContain("Built-in bundle · 1.6.1");
      expect(text).toContain(RELEASE);
      expectNoFragmentOf(text, id);
    },
  );

  it("names a moved report's earlier built-in bundle by its earlier app version", () => {
    const { container } = render(
      <EventBundleTransition
        event={{
          type: "UNCHANGED",
          appVersion: "1.7.0",
          fromBundleId: null,
          toBundleId: ARTIFACT,
          toReleaseId: RELEASE,
          minBundleId: PLATFORM_BYTE,
          change: {
            kinds: ["bundle", "app_version"],
            previous: {
              bundleId: ZERO_TAIL,
              releaseId: null,
              appVersion: "1.6.1",
              channel: "production",
              minBundleId: ZERO_TAIL,
            },
          },
        }}
      />,
    );
    const text = visibleText(container);
    expect(text).toContain("Built-in bundle · 1.6.1");
    expect(text).not.toContain("1.7.0");
    expectNoFragmentOf(text, ZERO_TAIL);
  });

  it("in the installations a search matches, and the one selected", () => {
    const row = {
      installId: "8d2f0c1e-4b7a-4e6d-9f3c-2a1b0c9d8e7f",
      userId: "kim",
      appVersion: "1.6.1",
      channel: "production",
      cohort: "1",
      platform: "ios",
      receivedAtMs: Date.UTC(2026, 10, 28),
      latestStatus: "UNCHANGED",
      lastKnownBundleId: ZERO_TAIL,
      lastKnownReleaseId: null,
      pendingBundleId: null,
      pendingReleaseId: null,
      minBundleId: ZERO_TAIL,
    } satisfies InsightsInstallationViewRow;
    const matches = render(
      <InstallationMatchesCard
        error={null}
        onNext={() => {}}
        onPrevious={() => {}}
        onSelect={() => {}}
        pageNumber={1}
        results={{ data: [row], nextCursor: null }}
        selectedInstallId={undefined}
      />,
    );
    const toggle = screen.queryByRole("button", { expanded: false });
    if (toggle) fireEvent.click(toggle);
    let text = visibleText(matches.container);
    expect(text).toContain("Built-in bundle · 1.6.1");
    expectNoFragmentOf(text, ZERO_TAIL);
    cleanup();

    const history = render(
      <InstallationHistoryCard
        error={null}
        history={{ data: [], nextCursor: null }}
        isLoading={false}
        onNext={() => {}}
        onPrevious={() => {}}
        pageNumber={1}
        selectedEvent={row}
        selectedInstallId={row.installId}
      />,
    );
    text = visibleText(
      within(history.container).getByRole("region", {
        name: "Latest reported state",
      }),
    );
    expect(text).toContain("Built-in bundle · 1.6.1");
    expectNoFragmentOf(text, ZERO_TAIL);
  });

  const nativeBuild = (overrides: Partial<NativeBuildRow>): NativeBuildRow => ({
    id: "019f6a0e-77c0-7a1b-9c2d-3e4f5a6b7c8d",
    scope_key: "scope",
    platform: "ios",
    channel_id: "channel:production",
    fingerprint_hash: null,
    app_version: "1.6.1",
    native_app_version: "1.6.1",
    min_bundle_id: ZERO_TAIL,
    artifact_kind: "ipa",
    artifact_storage_uri: "r2://bucket/native-builds/ios/App.ipa",
    byte_size: 1,
    git_commit_hash: null,
    created_at_ms: 0,
    build_key: null,
    build_number: "63",
    submitted_to: null,
    submitted_at_ms: null,
    submitted_version: null,
    is_store_build: false,
    is_sandbox: false,
    sandbox_url_scheme: null,
    export_method: null,
    ...overrides,
  });

  it.each([
    [{}, "Built-in bundle · 1.6.1 (63)"],
    [{ build_number: null }, "Built-in bundle · 1.6.1"],
    // A build number alone would read as an app version.
    [
      { build_number: "63", app_version: null, native_app_version: null },
      "Built-in bundle",
    ],
  ] as const)(
    "on its native build's page, by the build's version: %o",
    (overrides, name) => {
      const build = nativeBuild(overrides);
      const detail = {
        build,
        channel: "production",
        catalogScopeKey: "scope",
        builtInBundle: { childCount: 0 },
        newestInScope: build,
        storeBuildInScope: null,
        servedNow: [],
        patches: { data: [] },
        sibling: null,
      } satisfies NativeBuildDetail;
      const { container } = render(
        withQueries(<BuiltInBundleCard detail={detail} />),
      );
      const value = screen.getByText("Bundle ID").nextElementSibling!;
      expect(visibleText(value as HTMLElement)).toBe(name);
      expectNoFragmentOf(visibleText(container), ZERO_TAIL);
    },
  );

  it("in the link to a release's native build", async () => {
    vi.mocked(getReleaseNativeBuild).mockResolvedValue(nativeBuild({}));
    render(
      withQueries(
        <ReleaseNativeBuildLink
          bundle={{ patches: [] }}
          channel="production"
          release={{
            platform: "ios",
            fingerprint_hash: "fp",
            target_app_version: null,
            bundle_id: ARTIFACT,
          }}
        />,
      ),
    );
    const link = await screen.findByRole("link");
    const text = visibleText(link);
    expect(text).toContain("Built-in bundle · 1.6.1 (63)");
    expectNoFragmentOf(text, ZERO_TAIL);
  });

  it("in a filter chip, while a release's chip keeps its tail", () => {
    for (const id of BUILT_INS) {
      const chip = bundleChip(id, []);
      expect(chip).toBe("Built-in bundle");
      expectNoFragmentOf(chip, id);
    }
    expect(bundleChip(RELEASE, [{ releaseId: RELEASE, label: 7 }])).toBe(
      `Bundle v7 ${RELEASE.slice(-TAIL)}`,
    );
  });
});
