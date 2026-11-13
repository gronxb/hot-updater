import type { NativeBuildRow } from "@hot-updater/plugin-core";
import { encodeChannelKey } from "@hot-updater/protocol";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { qrCodePath } from "@/lib/qr-code";
import type { Fold } from "@/lib/server/foldedPage";
import type {
  NativeBuildDetail,
  NativeBuildPatchPage,
} from "@/lib/server/nativeBuilds";

import { BuiltInBundleCard } from "./BuiltInBundleCard";
import { InstallCard } from "./InstallCard";
import { NativeBuildsTable } from "./NativeBuildsTable";
import { PatchesCard } from "./PatchesCard";
import { firstDownloadOf, ServedNowCard } from "./ServedNowCard";

const {
  downloadLinkQuery,
  downloadUrlQuery,
  foldQuery,
  installEligibilityQuery,
  markMutate,
  patchesQuery,
  navigate,
} = vi.hoisted(() => ({
  downloadLinkQuery: vi.fn(),
  downloadUrlQuery: vi.fn(),
  foldQuery: vi.fn(),
  installEligibilityQuery: vi.fn(),
  markMutate: vi.fn(),
  patchesQuery: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  useConfigQuery: () => ({ data: { console: {} } }),
  useMarkNativeBuildMutation: () => ({ mutate: markMutate, isPending: false }),
  useNativeBuildDownloadLinkQuery: downloadLinkQuery,
  useNativeBuildDownloadUrlQuery: downloadUrlQuery,
  useNativeBuildFoldQuery: foldQuery,
  useNativeBuildInstallEligibilityQuery: installEligibilityQuery,
  useNativeBuildPatchesQuery: patchesQuery,
}));

/** A router link as its URL: the path with its params, then its search. */
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    params,
    search,
    ...props
  }: {
    children: ReactNode;
    to: string;
    params?: Record<string, string>;
    search?: Record<string, string>;
  }) => {
    const path = Object.entries(params ?? {}).reduce(
      (url, [key, value]) => url.replace(`$${key}`, value),
      to,
    );
    const query = new URLSearchParams(search ?? {}).toString();
    return (
      <a {...props} href={query === "" ? path : `${path}?${query}`}>
        {children}
      </a>
    );
  },
  useNavigate: () => navigate,
}));

const id = (n: number) =>
  `019a0000-0000-7000-8000-${String(n).padStart(12, "0")}`;

const build = (overrides: Partial<NativeBuildRow> = {}): NativeBuildRow => ({
  id: id(1),
  scope_key: "scope",
  platform: "android",
  channel_id: `channel:${encodeChannelKey("pr-130")}`,
  fingerprint_hash: "1a2b3c4d5e6f7a8b9c0d",
  app_version: null,
  min_bundle_id: id(2),
  artifact_kind: "apk",
  artifact_storage_uri:
    "r2://bucket/native-builds/android/019a/app-release.apk",
  byte_size: 52_428_800,
  git_commit_hash: "abcdef1234567",
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
  native_app_version: null,
  ...overrides,
});

const patchPage = (
  bundleIds: readonly string[],
  next?: string,
): NativeBuildPatchPage => ({
  data: bundleIds.map((bundleId) => ({ bundleId, byteSize: 40_960 })),
  ...(next === undefined ? {} : { next }),
});

const detail = (
  overrides: Partial<NativeBuildDetail> = {},
): NativeBuildDetail => {
  const row = overrides.build ?? build();
  return {
    build: row,
    channel: "pr-130",
    catalogScopeKey: "v1:fingerprint:android:cHItMTMw:1a2b3c4d5e6f7a8b9c0d",
    builtInBundle: { childCount: 2 },
    newestInScope: row,
    storeBuildInScope: null,
    servedNow: [],
    patches: patchPage([]),
    ...overrides,
  };
};

/** Text no part of the Native Builds pages may show: channel links are gone. */
const CHANNEL_LINK_TEXT =
  /Channel link|openurl|channelLinkPrefix|hot-updater\/channel\//;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("NativeBuildsTable", () => {
  /** A page of builds, each an ordinary row, or a mix of rows and folds. */
  const builds = (data: readonly (NativeBuildRow | Fold)[], page = {}) => ({
    data: {
      entries: data.map((entry) =>
        "kind" in entry ? entry : { kind: "row" as const, row: entry },
      ),
      ...page,
    },
    isError: false,
    isPending: false,
    isPlaceholderData: false,
    refetch: vi.fn(),
  });

  /** The text of `row`'s cell under the column headed `header`. */
  const cellText = (row: HTMLElement, header: string) => {
    const headers = screen
      .getAllByRole("columnheader")
      .map((cell) => cell.textContent);
    const index = headers.indexOf(header);
    expect(index, `a ${header} column`).toBeGreaterThanOrEqual(0);
    return row.querySelectorAll("td")[index]!.textContent;
  };

  it("badges the marked build, from its row", () => {
    render(
      <NativeBuildsTable
        builds={builds([build({ is_store_build: true }), build({ id: id(3) })])}
        channel={undefined}
        onChannel={vi.fn()}
        paged={false}
      />,
    );

    expect(screen.getAllByText("Store build")).toHaveLength(1);
  });

  it("tags a sandbox build beside its kind, from its record and not its channel", () => {
    render(
      <NativeBuildsTable
        builds={builds([
          build({ is_sandbox: true, submitted_to: "play-internal" }),
          build({
            id: id(3),
            channel_id: `channel:${encodeChannelKey("sandbox-release")}`,
          }),
        ])}
        channel={undefined}
        onChannel={vi.fn()}
        paged={false}
      />,
    );

    expect(screen.getAllByText("Sandbox")).toHaveLength(1);
    const [tagged, untagged] = screen.getAllByRole("row").slice(1);
    expect(cellText(tagged!, "Artifact")).toBe("APKSandbox");
    expect(cellText(tagged!, "Store")).not.toContain("Sandbox");
    expect(cellText(untagged!, "Artifact")).toBe("APK");
  });

  it("tags a sandbox build's card beside its kind, on its first line", () => {
    const width = window.innerWidth;
    window.innerWidth = 390;
    try {
      render(
        <NativeBuildsTable
          builds={builds([
            build({ is_sandbox: true }),
            build({
              id: id(3),
              channel_id: `channel:${encodeChannelKey("sandbox-release")}`,
            }),
          ])}
          channel={undefined}
          onChannel={vi.fn()}
          paged={false}
        />,
      );

      const [tagged, untagged] = screen.getAllByRole("article");
      const [header, channel] = [...tagged!.children];
      expect(header!.textContent).toBe("APKSandbox");
      expect(channel!.textContent).toBe("pr-130");
      expect(within(untagged!).queryByText("Sandbox")).toBeNull();
    } finally {
      window.innerWidth = width;
    }
  });

  it.each([
    [
      "zero random bits, as builds issue it",
      "019a1b2c-3d4e-7000-8000-000000000000",
    ],
    [
      "an earlier CLI's iOS platform byte",
      "019a1b2c-3d4e-7000-8000-01a1b2c3d4e5",
    ],
    [
      "an earlier CLI's Android platform byte",
      "019a1b2c-3d4e-7000-8000-02a1b2c3d4e5",
    ],
  ])(
    "shows a built-in bundle ID with %s in full on the build's page",
    (_form, minBundleId) => {
      render(
        <BuiltInBundleCard
          detail={detail({ build: build({ min_bundle_id: minBundleId }) })}
        />,
      );
      expect(
        screen.getByText("Bundle ID", { selector: "dt" }).nextElementSibling
          ?.textContent,
      ).toBe(minBundleId);
    },
  );

  it("keeps the columns people scan or act on, and leaves the built-in bundle and commit to the build's page", () => {
    render(
      <NativeBuildsTable
        builds={builds([build()])}
        channel={undefined}
        onChannel={vi.fn()}
        paged={false}
      />,
    );

    expect(
      screen.getAllByRole("columnheader").map((cell) => cell.textContent),
    ).toEqual([
      "Artifact",
      "Channel",
      "Platform",
      "Build",
      "Target",
      "Build key",
      "Store",
      "Size",
      "Created",
    ]);
    expect(screen.queryByText(id(2))).toBeNull();
    expect(screen.queryByTitle("abcdef1234567")).toBeNull();
  });

  it("lists each build with its decoded channel, and opens its page", () => {
    const row = build();
    const onChannel = vi.fn();
    render(
      <NativeBuildsTable
        builds={builds([row], { next: row.id })}
        channel={undefined}
        onChannel={onChannel}
        paged={false}
      />,
    );

    expect(screen.getByRole("link", { name: "Android APK" })).toHaveProperty(
      "href",
      expect.stringContaining(`/native-builds/${row.id}`),
    );
    // The fingerprint as the Bundles table's Target shows it.
    const [, buildRow] = screen.getAllByRole("row");
    expect(cellText(buildRow!, "Target")).toBe("1a2b3c4d…9c0d");
    expect(cellText(buildRow!, "Platform")).toBe("Android");
    expect(cellText(buildRow!, "Size")).toBe("50.0 MB");
    // The channel comes from the ID, with no channel read.
    fireEvent.click(
      screen.getByRole("button", {
        name: "Show the builds that embed pr-130",
      }),
    );
    expect(onChannel).toHaveBeenCalledWith("pr-130");
    expect(navigate).not.toHaveBeenCalled();
    // The build's page installs it, so a row has no download of its own.
    expect(screen.queryByRole("link", { name: /Download/ })).toBeNull();

    fireEvent.click(screen.getByText("50.0 MB"));
    expect(navigate).toHaveBeenCalledWith({
      to: "/native-builds/$buildId",
      params: { buildId: row.id },
    });
    expect(document.body.textContent).not.toMatch(CHANNEL_LINK_TEXT);
  });

  it("shows the target and the build key in their own columns, shortened as Bundles shortens a fingerprint", () => {
    const fingerprint = "e7b2a84d0123456789abcdef0123456789ab9efb";
    const buildKey = `nbk1:a1b2c3d4${"0".repeat(52)}9f0e`;
    render(
      <NativeBuildsTable
        builds={builds([
          build({ fingerprint_hash: fingerprint, build_key: buildKey }),
        ])}
        channel={undefined}
        onChannel={vi.fn()}
        paged={false}
      />,
    );

    const row = screen.getAllByRole("row")[1]!;
    // The Bundles table's Target cell: `xxxxxxxx…xxxx`, the full value copied.
    expect(cellText(row, "Target")).toBe("e7b2a84d…9efb");
    expect(
      screen.getByRole("button", { name: `Copy full value: ${fingerprint}` })
        .textContent,
    ).toBe("e7b2a84d…9efb");
    // The build key past its `nbk1:` prefix, shortened as the fingerprint is.
    expect(cellText(row, "Build key")).toBe("a1b2c3d4…9f0e");
    expect(
      screen.getByRole("button", { name: `Copy full value: ${buildKey}` }),
    ).toBeTruthy();
  });

  it("shows an app-version build's target as its app version, and an imported build's missing build key as -", () => {
    render(
      <NativeBuildsTable
        builds={builds([
          build({
            fingerprint_hash: null,
            app_version: "1.4.2",
            build_key: null,
          }),
        ])}
        channel={undefined}
        onChannel={vi.fn()}
        paged={false}
      />,
    );

    const row = screen.getAllByRole("row")[1]!;
    expect(cellText(row, "Target")).toBe("1.4.2");
    expect(cellText(row, "Build key")).toBe("-");
    expect(
      screen.queryByRole("button", { name: /Copy full value/ }),
    ).toBeNull();
  });

  it("shows the app version every artifact reports in Target: over a fingerprint build's fingerprint, and once on an app-version build", () => {
    const fingerprint = "e7b2a84d0123456789abcdef0123456789ab9efb";
    render(
      <NativeBuildsTable
        builds={builds([
          build({
            id: id(11),
            fingerprint_hash: fingerprint,
            native_app_version: "1.6.0",
          }),
          build({
            id: id(12),
            fingerprint_hash: null,
            app_version: "1.4.2",
            native_app_version: "1.4.2",
          }),
          // Registered before the version was recorded, or by an older
          // server, which leaves the field out.
          build({ id: id(13), fingerprint_hash: fingerprint }),
          {
            ...build({ id: id(14), fingerprint_hash: fingerprint }),
            native_app_version: undefined,
          },
        ])}
        channel={undefined}
        onChannel={vi.fn()}
        paged={false}
      />,
    );

    const [, versioned, byVersion, older, olderServer] =
      screen.getAllByRole("row");
    expect(cellText(versioned!, "Target")).toBe(
      "App version 1.6.0e7b2a84d…9efb",
    );
    expect(
      within(versioned!).getByTitle("The app version this build reports")
        .textContent,
    ).toBe("App version 1.6.0");
    // The version reads first, over the fingerprint it is copied by.
    const target = within(versioned!).getByText("1.6.0");
    expect(
      target.compareDocumentPosition(
        within(versioned!).getByRole("button", {
          name: `Copy full value: ${fingerprint}`,
        }),
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(cellText(byVersion!, "Target")).toBe("1.4.2");
    // Without one, the fingerprint alone, as before.
    expect(cellText(older!, "Target")).toBe("e7b2a84d…9efb");
    expect(cellText(olderServer!, "Target")).toBe("e7b2a84d…9efb");
  });

  it("shows a fingerprint build's app version on its card, over its fingerprint and beside its build key", () => {
    const width = window.innerWidth;
    window.innerWidth = 390;
    try {
      render(
        <NativeBuildsTable
          builds={builds([
            build({
              build_key: `nbk1:a1b2c3d4${"0".repeat(52)}9f0e`,
              native_app_version: "1.6.0",
            }),
          ])}
          channel={undefined}
          onChannel={vi.fn()}
          paged={false}
        />,
      );
      const hashes = screen.getByRole("article").children[3]!;
      expect(hashes.textContent).toBe(
        "Target App version 1.6.01a2b3c4d…9c0dBuild key a1b2c3d4…9f0e",
      );
    } finally {
      window.innerWidth = width;
    }
  });

  it("shows each build as a compact card at 390 px: what it is, then where, then when, then target and build key, then store", () => {
    const width = window.innerWidth;
    window.innerWidth = 390;
    try {
      const row = build({
        build_key: `nbk1:a1b2c3d4${"0".repeat(52)}9f0e`,
        build_number: "66",
        submitted_to: "play-internal",
        submitted_at_ms: Date.now(),
        submitted_version: "1.3.0 (66)",
        is_store_build: true,
      });
      render(
        <NativeBuildsTable
          builds={builds([row])}
          channel={undefined}
          onChannel={vi.fn()}
          paged={false}
        />,
      );

      expect(screen.queryByRole("table")).toBeNull();
      const card = screen.getByRole("article");
      // No label-value boxes: lines of values, a few cards to a screen.
      expect(card.querySelector("dl")).toBeNull();
      const [primary, where, meta, hashes, store] = [...card.children];
      expect(
        within(primary as HTMLElement).getByRole("link", {
          name: "Android APK",
        }).textContent,
      ).toBe("APK");
      expect(
        within(where as HTMLElement).getByRole("button", {
          name: "Show the builds that embed pr-130",
        }),
      ).toBeTruthy();
      expect(within(card).queryByRole("link", { name: /Download/ })).toBeNull();
      expect(meta!.textContent).toMatch(/^AndroidBuild 66·50\.0 MB·.+ ago$/);
      expect(hashes!.textContent).toBe(
        "Target 1a2b3c4d…9c0dBuild key a1b2c3d4…9f0e",
      );
      expect(store!.textContent).toBe("Play internal1.3.0 (66)Store build");
      // The built-in bundle and commit are on the build's page.
      expect(card.textContent).not.toContain(row.min_bundle_id);
      fireEvent.click(meta!);
      expect(navigate).toHaveBeenCalledWith({
        to: "/native-builds/$buildId",
        params: { buildId: row.id },
      });
    } finally {
      window.innerWidth = width;
    }
  });

  it("leaves an imported build's card without a build key line or store line", () => {
    const width = window.innerWidth;
    window.innerWidth = 390;
    try {
      render(
        <NativeBuildsTable
          builds={builds([build({ build_key: null })])}
          channel={undefined}
          onChannel={vi.fn()}
          paged={false}
        />,
      );
      const card = screen.getByRole("article");
      // What and its download, where, when, and the target: no store line.
      expect(card.children).toHaveLength(4);
      expect(card.textContent).not.toContain("Build key");
    } finally {
      window.innerWidth = width;
    }
  });

  it("shows the build number the artifact reports, from the row", () => {
    render(
      <NativeBuildsTable
        builds={builds([build({ build_number: "66" })])}
        channel={undefined}
        onChannel={vi.fn()}
        paged={false}
      />,
    );

    expect(cellText(screen.getAllByRole("row")[1]!, "Build")).toBe("66");
  });

  it("marks a build a store took with its track and the store's label, from the row alone", () => {
    const submitted = build({
      id: id(5),
      platform: "ios",
      artifact_kind: "ipa",
      artifact_storage_uri: "r2://bucket/native-builds/ios/019a/App.ipa",
      submitted_to: "testflight",
      submitted_at_ms: Date.now() - 3 * 86_400_000,
      submitted_version: "1.7.0 (66)",
    });
    render(
      <NativeBuildsTable
        builds={builds([submitted, build()])}
        channel={undefined}
        onChannel={vi.fn()}
        paged={false}
      />,
    );

    const [, submittedRow, plainRow] = screen.getAllByRole("row");
    expect(cellText(plainRow!, "Build")).toBe("-");
    expect(submittedRow!.textContent).toContain("TestFlight");
    expect(submittedRow!.textContent).toContain("1.7.0 (66)");
    // When it was submitted is the badge's tooltip; the row's time is the
    // build's own, under Created.
    expect(cellText(submittedRow!, "Store")).not.toContain("3 days ago");
    expect(
      screen.getByTitle(/^Submitted to TestFlight 3 days ago, /),
    ).toBeTruthy();
    // A build no store took shows no store.
    expect(plainRow!.textContent).not.toMatch(/TestFlight|Play internal/);
  });

  it("gives an empty registry the command that registers a build", () => {
    render(
      <NativeBuildsTable
        builds={builds([])}
        channel={undefined}
        onChannel={vi.fn()}
        paged={false}
      />,
    );

    expect(screen.getByText("No native builds")).toBeTruthy();
    // A build made elsewhere is tracked with the CLI, not uploaded here.
    expect(
      screen.getByText("npx hot-updater native-build import <file>"),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: /Import guide/ })).toHaveProperty(
      "href",
      "https://hot-updater.dev/docs/guides/native-build#import-a-build-made-elsewhere",
    );
    expect(
      screen.getByRole("link", { name: /Native build guide/ }),
    ).toHaveProperty(
      "href",
      "https://hot-updater.dev/docs/guides/native-build#how-a-build-is-tracked",
    );
  });

  it("leads an empty channel back to every channel's builds", () => {
    const onChannel = vi.fn();
    render(
      <NativeBuildsTable
        builds={builds([])}
        channel="pr-131"
        onChannel={onChannel}
        paged={false}
      />,
    );

    expect(screen.getByText(/No native build embeds/).textContent).toContain(
      "pr-131",
    );
    fireEvent.click(screen.getByRole("button", { name: "Show all channels" }));
    expect(onChannel).toHaveBeenCalledWith(undefined);
  });

  it("leads an empty older page back to the channel's newest builds", () => {
    render(
      <NativeBuildsTable
        builds={builds([])}
        channel="pr-130"
        onChannel={vi.fn()}
        paged
      />,
    );

    expect(
      screen.getByRole("link", { name: "Show the newest builds" }),
    ).toHaveProperty(
      "href",
      expect.stringMatching(/\/native-builds\?channel=pr-130$/),
    );
  });

  it("pages with Previous and Next as Bundles does, and offers Newest past the first page", () => {
    render(
      <NativeBuildsTable
        builds={builds([build()], { next: id(9), previous: { after: id(8) } })}
        channel="pr-130"
        onChannel={vi.fn()}
        paged
      />,
    );

    const pages = screen.getByRole("navigation", {
      name: "Native build pages",
    });
    expect(pages.textContent).toContain("1 build, newest first");
    expect(
      screen.getByRole("link", { name: "Previous" }).getAttribute("href"),
    ).toBe(`/native-builds?channel=pr-130&after=${id(8)}`);
    expect(
      screen.getByRole("link", { name: "Next" }).getAttribute("href"),
    ).toBe(`/native-builds?channel=pr-130&before=${id(9)}`);
    expect(
      screen.getByRole("link", { name: "Newest" }).getAttribute("href"),
    ).toBe("/native-builds?channel=pr-130");
  });

  it("keeps the pager disabled while the previous channel's page stands in for the new one", () => {
    render(
      <NativeBuildsTable
        builds={{
          ...builds([build()], { next: id(9), previous: { after: id(8) } }),
          isPlaceholderData: true,
        }}
        channel="pr-131"
        onChannel={vi.fn()}
        paged
      />,
    );

    // Its cursors belong to the previous channel's list.
    for (const name of ["Previous", "Next", "Newest"]) {
      expect(screen.queryByRole("link", { name })).toBeNull();
    }
    expect(
      screen.getByRole("button", { name: "Previous" }).hasAttribute("disabled"),
    ).toBe(true);
    expect(
      screen.getByRole("button", { name: "Next" }).hasAttribute("disabled"),
    ).toBe(true);
  });

  it("disables Previous and Next at the ends, with no Newest on the first page", () => {
    render(
      <NativeBuildsTable
        builds={builds([build()])}
        channel={undefined}
        onChannel={vi.fn()}
        paged={false}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Previous" }).hasAttribute("disabled"),
    ).toBe(true);
    expect(
      screen.getByRole("button", { name: "Next" }).hasAttribute("disabled"),
    ).toBe(true);
    expect(screen.queryByRole("link", { name: "Newest" })).toBeNull();
  });

  describe("older builds, folded where they sit", () => {
    const production = `channel:${encodeChannelKey("production")}`;
    const ios = (n: number, overrides: Partial<NativeBuildRow> = {}) =>
      build({
        id: id(n),
        platform: "ios",
        channel_id: production,
        app_version: "1.7.0",
        fingerprint_hash: null,
        artifact_kind: "ipa",
        build_number: String(n),
        created_at_ms: n,
        ...overrides,
      });
    const testflight = (n: number, overrides: Partial<NativeBuildRow> = {}) =>
      ios(n, {
        submitted_to: "testflight",
        submitted_at_ms: n,
        submitted_version: `1.7.0 (${n})`,
        ...overrides,
      });
    const fold = (from: number, to: number, count: number, more = false) =>
      ({
        kind: "fold",
        count,
        more,
        from: id(from),
        to: id(to),
      }) as const satisfies Fold;
    // As the server pages them: TestFlight 80 leads, 79 and 78 fold under it;
    // the store build 77 leads; 76 folds under it.
    const page = [
      testflight(80),
      fold(80, 78, 2),
      testflight(77, { is_store_build: true }),
      fold(77, 76, 1),
    ];
    /** What the fold query answers once the fold under `from` opens. */
    const foldAnswers = (
      answers: Record<number, Parameters<typeof foldPage>[0]>,
    ) =>
      foldQuery.mockImplementation(
        (_channel: unknown, bounds: { from?: string }, enabled: boolean) => {
          const from = Number(bounds.from?.slice(-12));
          return enabled && answers[from] !== undefined
            ? foldPage(answers[from])
            : { data: undefined, isPending: true, isError: false };
        },
      );
    const foldPage = ({
      rows,
      newer = {},
      hasNextPage = false,
    }: {
      rows: NativeBuildRow[];
      newer?: Record<string, NativeBuildRow>;
      hasNextPage?: boolean;
    }) => ({
      data: { pages: [{ rows, newer }] },
      isPending: false,
      isError: false,
      isFetchingNextPage: false,
      hasNextPage,
      fetchNextPage: vi.fn(),
      refetch: vi.fn(),
    });
    const rowNames = () =>
      screen
        .getAllByRole("row")
        .slice(1)
        .map((row) => row.getAttribute("aria-label") ?? row.textContent);
    const table = (data = page, props = {}) => (
      <NativeBuildsTable
        builds={builds(data)}
        channel={undefined}
        onChannel={vi.fn()}
        paged={false}
        {...props}
      />
    );

    beforeEach(() => {
      foldAnswers({});
    });

    it("keeps the list's order, each run of older builds one closed fold where it sits", () => {
      render(table());

      expect(rowNames()).toEqual([
        `Open native build ${id(80)}`,
        "2 older builds",
        `Open native build ${id(77)}`,
        "1 older build",
      ]);
      for (const name of ["2 older builds", "1 older build"]) {
        const button = screen.getByRole("button", { name });
        expect(button.getAttribute("aria-expanded")).toBe("false");
        // It names the group its rows open in, which exists while closed.
        const panel = document.getElementById(
          button.getAttribute("aria-controls")!,
        );
        expect(panel?.tagName).toBe("TBODY");
        expect(panel?.hidden).toBe(true);
      }
      // No "Unreachable": an older build may still install.
      expect(screen.queryByText(/Unreachable/)).toBeNull();
      // Nothing of a closed fold is read.
      expect(
        foldQuery.mock.calls.every(([, , enabled]) => enabled === false),
      ).toBe(true);
      // The pager counts the ordinary rows, and what the folds hold.
      expect(
        screen
          .getByRole("navigation", { name: "Native build pages" })
          .querySelector("p")?.textContent,
      ).toBe("2 builds, newest first · , 3 older folded");
    });

    it("opens one fold in place: exactly its range, in order, each build shaded and naming its newer build", async () => {
      foldAnswers({
        80: {
          rows: [testflight(79), testflight(78)],
          newer: { [id(79)]: testflight(80), [id(78)]: testflight(80) },
        },
      });
      render(table());
      fireEvent.click(screen.getByRole("button", { name: "2 older builds" }));

      expect(foldQuery).toHaveBeenCalledWith(
        undefined,
        { from: id(80), to: id(78) },
        true,
      );
      // The other fold stays closed, and reads nothing.
      expect(foldQuery).not.toHaveBeenCalledWith(
        undefined,
        { from: id(77), to: id(76) },
        true,
      );
      expect(rowNames()).toEqual([
        `Open native build ${id(80)}`,
        "2 older builds",
        `Open native build ${id(79)}`,
        `Open native build ${id(78)}`,
        `Open native build ${id(77)}`,
        "1 older build",
      ]);
      expect(
        screen
          .getByRole("button", { name: "1 older build" })
          .getAttribute("aria-expanded"),
      ).toBe("false");
      const older = screen.getByRole("row", {
        name: `Open native build ${id(79)}`,
      });
      expect(older.getAttribute("data-older")).toBe("true");
      expect(older.className).toContain("data-[older=true]:bg-muted/60");
      const reason = within(older).getByRole("button", { name: /^Older/ });
      // In the first column beside the kind, where Bundles says "Unreachable";
      // Created keeps only the time.
      const cells = within(older).getAllByRole("cell");
      expect(cells[0]!.contains(reason)).toBe(true);
      expect(cells[0]!.firstElementChild?.className).toContain("max-w-24");
      expect(
        cells.slice(1).some((cell) => /Older/.test(cell.textContent ?? "")),
      ).toBe(false);
      expect(reason.getAttribute("aria-label")).toBe(
        "Older: a newer TestFlight build exists, iOS 1.7.0 (80)",
      );
      fireEvent.click(reason);
      expect((await screen.findByRole("tooltip")).textContent).toBe(
        "A newer TestFlight build exists: iOS 1.7.0 (80)",
      );
      expect(navigate).not.toHaveBeenCalled();
    });

    it("keeps the page's links when a fold opens: opening reads only the fold", () => {
      foldAnswers({ 80: { rows: [testflight(79), testflight(78)] } });
      render(
        <NativeBuildsTable
          builds={builds(page, {
            next: id(76),
            previous: { before: `s.${id(80)}` },
          })}
          channel="production"
          onChannel={vi.fn()}
          paged
        />,
      );
      const links = () =>
        ["Previous", "Next", "Newest"].map((name) =>
          screen.getByRole("link", { name }).getAttribute("href"),
        );
      const before = links();
      fireEvent.click(screen.getByRole("button", { name: "2 older builds" }));

      expect(links()).toEqual(before);
      expect(before).toEqual([
        `/native-builds?channel=production&before=s.${id(80)}`,
        `/native-builds?channel=production&before=${id(76)}`,
        "/native-builds?channel=production",
      ]);
    });

    it("shades a fold's build and says it is older though its newer build wasn't found", () => {
      foldAnswers({ 80: { rows: [testflight(79)] } });
      render(table());
      fireEvent.click(screen.getByRole("button", { name: "2 older builds" }));

      const older = screen.getByRole("row", {
        name: `Open native build ${id(79)}`,
      });
      expect(older.getAttribute("data-older")).toBe("true");
      expect(
        within(older)
          .getByRole("button", { name: /^Older/ })
          .getAttribute("aria-label"),
      ).toBe("Older: a newer build on its channel reaches people the same way");
    });

    it("names the rows an open fold couldn't load, with Retry", () => {
      const failed = {
        data: undefined,
        isPending: false,
        isError: true,
        isFetchingNextPage: false,
        hasNextPage: false,
        fetchNextPage: vi.fn(),
        refetch: vi.fn(),
      };
      foldQuery.mockImplementation(
        (_channel: unknown, _bounds: unknown, enabled: boolean) =>
          enabled ? failed : { data: undefined, isPending: true },
      );
      render(table());
      fireEvent.click(screen.getByRole("button", { name: "2 older builds" }));

      expect(screen.getByRole("status").textContent).toBe(
        "Older builds couldn't be loaded.",
      );
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      expect(failed.refetch).toHaveBeenCalled();
    });

    it("says 100+ for a fold past its cap, and loads more of it on request", () => {
      const more = foldPage({ rows: [testflight(79)], hasNextPage: true });
      foldQuery.mockImplementation(
        (_channel: unknown, _bounds: unknown, enabled: boolean) =>
          enabled ? more : { data: undefined, isPending: true },
      );
      render(table([testflight(80), fold(80, 1, 100, true)]));
      fireEvent.click(
        screen.getByRole("button", { name: "100+ older builds" }),
      );
      fireEvent.click(screen.getByRole("button", { name: "Show more" }));

      expect(more.fetchNextPage).toHaveBeenCalled();
      // A capped fold makes the total a floor.
      expect(
        screen
          .getByRole("navigation", { name: "Native build pages" })
          .querySelector("p")?.textContent,
      ).toBe("1 build, newest first · , 100+ older folded");
    });

    it("shows a page of older builds alone as one fold under the empty state", () => {
      render(table([fold(90, 60, 30)], { paged: true }));

      expect(screen.getByText("Each build here has a newer one")).toBeTruthy();
      expect(
        screen.getByRole("button", { name: "30 older builds" }),
      ).toBeTruthy();
      expect(
        screen.getByRole("link", { name: "Show the newest builds" }),
      ).toBeTruthy();
    });

    it("folds the cards on a phone the same way, in place", () => {
      const width = window.innerWidth;
      window.innerWidth = 390;
      try {
        foldAnswers({ 80: { rows: [testflight(79), testflight(78)] } });
        render(table());

        const items = () =>
          within(screen.getByRole("list", { name: "Native builds" }))
            .getAllByRole("listitem")
            .map(
              (item) =>
                item.querySelector("article")?.getAttribute("aria-label") ??
                item.textContent,
            );
        expect(items()).toEqual([
          `Native build iOS IPA ${id(80)}`,
          "2 older builds",
          `Native build iOS IPA ${id(77)}`,
          "1 older build",
        ]);
        const button = screen.getByRole("button", { name: "2 older builds" });
        expect(
          document.getElementById(button.getAttribute("aria-controls")!),
        ).not.toBeNull();
        fireEvent.click(button);
        expect(items()).toEqual([
          `Native build iOS IPA ${id(80)}`,
          "2 older builds",
          `Native build iOS IPA ${id(79)}`,
          `Native build iOS IPA ${id(78)}`,
          `Native build iOS IPA ${id(77)}`,
          "1 older build",
        ]);
      } finally {
        window.innerWidth = width;
      }
    });
  });

  it("opens a build from the keyboard, as a Bundles row does", () => {
    const row = build();
    render(
      <NativeBuildsTable
        builds={builds([row])}
        channel={undefined}
        onChannel={vi.fn()}
        paged={false}
      />,
    );

    fireEvent.keyDown(
      screen.getByRole("row", { name: `Open native build ${row.id}` }),
      { key: "Enter" },
    );
    expect(navigate).toHaveBeenCalledWith({
      to: "/native-builds/$buildId",
      params: { buildId: row.id },
    });
  });
});

const ISSUED_LINK = {
  status: "issued",
  token: "1798761600.signature",
  expiresAt: "2026-11-30T12:00:00.000Z",
};

const signedUrl = (buildId: string) =>
  `http://localhost:3000/api/native-builds/${buildId}/download?t=1798761600.signature`;

/** What a phone's camera reads from the card's QR code. */
const expectQrCodeOf = (container: HTMLElement, value: string) => {
  expect(container.querySelector("svg[role=img] path")?.getAttribute("d")).toBe(
    qrCodePath(value).path,
  );
};

/** The Console can't sign: the card falls back on the storage's URL. */
const unsigned = (url: string | null, status = "local-console") => {
  downloadLinkQuery.mockReturnValue({
    data: { status, secretName: "BETTER_AUTH_SECRET" },
  });
  downloadUrlQuery.mockReturnValue({ data: { url } });
};

describe("InstallCard", () => {
  beforeEach(() => {
    downloadLinkQuery.mockReturnValue({ data: ISSUED_LINK });
    downloadUrlQuery.mockReset();
  });

  describe("with a signed link", () => {
    it("puts the link in an APK's QR code and download, and reads no storage URL", () => {
      const row = build();
      const { container } = render(<InstallCard build={row} />);

      expect(downloadLinkQuery).toHaveBeenCalledWith(row.id);
      expectQrCodeOf(container, signedUrl(row.id));
      expect(
        screen.getByRole("link", { name: /Download app-release.apk/ }),
      ).toHaveProperty("href", signedUrl(row.id));
      expect(downloadUrlQuery).not.toHaveBeenCalled();
    });

    it("shows the link to copy, who can use it, and until when", () => {
      render(<InstallCard build={build()} />);

      expect(screen.getByText(signedUrl(build().id))).toBeTruthy();
      expect(
        screen.getByRole("button", { name: "Copy the download link" }),
      ).toBeTruthy();
      expect(document.body.textContent).toMatch(
        /Anyone with this link can download this build until 2026-11-30\./,
      );
    });

    it("gives each build its own link", () => {
      const first = build();
      const other = { ...first, id: id(99) };
      downloadLinkQuery.mockImplementation((buildId: string) => ({
        data:
          buildId === other.id
            ? { ...ISSUED_LINK, token: "1798761600.other" }
            : ISSUED_LINK,
      }));
      const { container, rerender } = render(<InstallCard build={first} />);
      expectQrCodeOf(container, signedUrl(first.id));

      rerender(<InstallCard build={other} />);

      expectQrCodeOf(
        container,
        `http://localhost:3000/api/native-builds/${other.id}/download?t=1798761600.other`,
      );
    });

    it("waits for the link rather than show a code that needs a session", () => {
      downloadLinkQuery.mockReturnValue({ data: undefined, isError: false });
      const row = build();
      render(<InstallCard build={row} />);

      expect(screen.queryByRole("img")).toBeNull();
      expect(downloadUrlQuery).not.toHaveBeenCalled();
      expect(
        screen.getByRole("link", { name: /Download app-release.apk/ }),
      ).toHaveProperty(
        "href",
        expect.stringMatching(
          new RegExp(`/api/native-builds/${row.id}/download$`),
        ),
      );
    });

    it("says so when the link can't be created", () => {
      downloadLinkQuery.mockReturnValue({
        data: undefined,
        error: new Error("Console unavailable"),
        isError: true,
      });
      render(<InstallCard build={build()} />);

      expect(screen.getByText("Console unavailable")).toBeTruthy();
      expect(downloadUrlQuery).not.toHaveBeenCalled();
    });

    it("keeps a link it has when reading a new one fails", () => {
      downloadLinkQuery.mockReturnValue({
        data: ISSUED_LINK,
        error: new Error("Console unavailable"),
        isError: true,
      });
      const row = build();
      const { container } = render(<InstallCard build={row} />);

      expectQrCodeOf(container, signedUrl(row.id));
      expect(screen.queryByText("Console unavailable")).toBeNull();
    });
  });

  describe("when the Console can't sign a link", () => {
    it("shows a local Console's storage URL as the QR code, and says it expires", () => {
      const url = "https://r2.example.com/app-release.apk?sig=1";
      unsigned(url);
      const row = build();
      const { container } = render(<InstallCard build={row} />);

      expectQrCodeOf(container, url);
      expect(downloadUrlQuery).toHaveBeenCalledWith(row.id);
      expect(screen.getByText(/This link expires/)).toBeTruthy();
      expect(
        screen.getByRole("link", { name: /Download app-release.apk/ }),
      ).toHaveProperty(
        "href",
        expect.stringMatching(
          new RegExp(`/api/native-builds/${row.id}/download$`),
        ),
      );
      // Only this machine reaches a local Console, so nothing to copy or ask.
      expect(screen.queryByRole("status")).toBeNull();
      expect(
        screen.queryByRole("button", { name: "Copy the download link" }),
      ).toBeNull();
    });

    it("tells a hosted Console without the secret what to set", () => {
      unsigned("https://r2.example.com/app-release.apk?sig=1", "no-secret");
      render(<InstallCard build={build()} />);

      expect(screen.getByRole("status").textContent).toBe(
        "Set BETTER_AUTH_SECRET on the Console to create links.",
      );
    });

    it("shows a skeleton, then the failure, while reading the storage URL", () => {
      unsigned(null);
      downloadUrlQuery.mockReturnValue({ data: undefined, isError: false });
      const { container } = render(<InstallCard build={build()} />);
      expect(container.querySelector("svg[role=img]")).toBeNull();
      cleanup();

      downloadUrlQuery.mockReturnValue({
        data: undefined,
        error: new Error("Storage unavailable"),
        isError: true,
      });
      render(<InstallCard build={build()} />);
      expect(screen.getByText("Storage unavailable")).toBeTruthy();
    });
  });

  it("tells an APK's installer what Android needs, and the way past another key", () => {
    const { container } = render(<InstallCard build={build()} />);
    const copy = container.textContent;

    expect(copy).toContain('"Install unknown apps" permission');
    expect(copy).toMatch(
      /another signing key, such as a Play copy, the install fails\. Uninstall that copy first, or build with sandbox: true, whose \.sandbox ID installs beside it\./,
    );
    expect(
      screen.getByText(`npx hot-updater native-build install ${id(1)}`),
    ).toBeTruthy();
    expect(copy).not.toMatch(/adb install/);
    expect(copy).not.toMatch(CHANNEL_LINK_TEXT);
  });

  it("tells a sandbox APK's installer it installs beside a Play copy, not to build a sandbox", () => {
    const { container } = render(
      <InstallCard build={build({ is_sandbox: true })} />,
    );
    const copy = container.textContent;

    expect(copy).toContain('"Install unknown apps" permission');
    expect(copy).toContain("Its .sandbox ID installs it beside a Play copy.");
    expect(copy).not.toMatch(/sandbox: true|Uninstall that copy/);
    expect(
      screen.getByText(`npx hot-updater native-build install ${id(1)}`),
    ).toBeTruthy();
  });

  it.each(["aab", "ipa", "app"] as const)(
    "leaves Android's install notes off an %s",
    (kind) => {
      const { container } = render(
        <InstallCard build={build({ artifact_kind: kind })} />,
      );

      expect(container.textContent).not.toMatch(/unknown apps|signing key/);
    },
  );

  it.each([
    [
      "apk",
      "android",
      "app-release.apk",
      /Scan with an Android phone's camera, then open the APK/,
    ],
    [
      "aab",
      "android",
      "app-release.aab",
      /Scan to download\. The \.aab installs through Google Play or bundletool/,
    ],
    [
      "app",
      "ios",
      "HotUpdaterExample.app.zip",
      /Scan to download the \.app\.zip on a Mac/,
    ],
  ] as const)(
    "shows the download QR code of an %s, with what scanning it gets",
    (kind, platform, file, caption) => {
      const row = build({
        platform,
        artifact_kind: kind,
        artifact_storage_uri: `r2://bucket/native-builds/${platform}/019a/${file}`,
      });
      const { container } = render(<InstallCard build={row} />);

      expect(
        screen.getByRole("img", { name: `Download ${file}` }),
      ).toBeTruthy();
      expectQrCodeOf(container, signedUrl(row.id));
      expect(screen.getByText(caption)).toBeTruthy();
    },
  );

  describe("an IPA, away from an iPhone", () => {
    const ipa = () =>
      build({
        platform: "ios",
        artifact_kind: "ipa",
        artifact_storage_uri: "r2://bucket/native-builds/ios/019a/App.ipa",
      });

    it("holds this page in its QR code rather than the file, reads nothing about the IPA, and keeps the file's download", () => {
      const row = ipa();
      const { container } = render(<InstallCard build={row} />);

      expect(
        screen.getByRole("img", { name: "Open this page on an iPhone" }),
      ).toBeTruthy();
      expectQrCodeOf(
        container,
        `${window.location.origin}${window.location.pathname}`,
      );
      expect(screen.getByText(/Scan with an iPhone to install/)).toBeTruthy();
      expect(installEligibilityQuery).not.toHaveBeenCalled();
      expect(
        screen.getByRole("link", { name: /Download App\.ipa/ }),
      ).toBeTruthy();
    });
  });

  // Each fact once per card, counted over the card's text: the QR code's
  // caption says it, and the steps beside it don't say it again.
  it.each([
    ["apk", "android", "app-release.apk", {}, [/camera/g, /USB/g]],
    ["aab", "android", "app-release.aab", {}, [/bundletool/g, /Google Play/g]],
    [
      "aab",
      "android",
      "app-release.aab",
      {
        submitted_to: "play-internal",
        submitted_at_ms: 0,
        submitted_version: "1.7.0 (66)",
      },
      [/rolled out/g],
    ],
    [
      "ipa",
      "ios",
      "App.ipa",
      {},
      [/Scan with an iPhone/g, /Apple Configurator/g],
    ],
    [
      "ipa",
      "ios",
      "App.ipa",
      {
        submitted_to: "testflight",
        submitted_at_ms: 0,
        submitted_version: "1.7.0 (66)",
      },
      [/testers/g, /processed/g],
    ],
    [
      "app",
      "ios",
      "HotUpdaterExample.app.zip",
      {},
      [/simulator/gi, /on a Mac/g, /to download/gi],
    ],
  ] as const)(
    "says each thing about installing an %s once",
    (kind, platform, file, submission, facts) => {
      const { container } = render(
        <InstallCard
          build={build({
            platform,
            artifact_kind: kind,
            artifact_storage_uri: `r2://bucket/native-builds/${platform}/019a/${file}`,
            ...submission,
          })}
        />,
      );
      // The download button names the file; the rest is the card's copy.
      const copy = [...container.querySelectorAll("p")]
        .map((paragraph) => paragraph.textContent)
        .join(" ");
      for (const fact of facts) {
        expect(copy.match(fact), String(fact)).toHaveLength(1);
      }
    },
  );

  it("shows no QR code when the storage has no download URL a phone can open", () => {
    unsigned(null);
    render(
      <InstallCard
        build={build({
          platform: "ios",
          artifact_kind: "ipa",
          artifact_storage_uri: "r2://bucket/native-builds/ios/019a/App.ipa",
        })}
      />,
    );

    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByText(/there is no QR code/)).toBeTruthy();
  });

  // Without a QR code there is no caption: what the artifact installs on
  // stays on the card, once.
  it.each([
    ["ipa", "ios", "App.ipa", /signing profile/g],
    ["aab", "android", "app-release.aab", /bundletool/g],
  ] as const)(
    "keeps what an %s installs on when there is no QR code",
    (kind, platform, file, limit) => {
      unsigned(null);
      const { container } = render(
        <InstallCard
          build={build({
            platform,
            artifact_kind: kind,
            artifact_storage_uri: `r2://bucket/native-builds/${platform}/019a/${file}`,
          })}
        />,
      );

      expect(screen.queryByRole("img")).toBeNull();
      expect(container.textContent!.match(limit)).toHaveLength(1);
    },
  );

  it("keeps a simulator app's install command beside its QR code", () => {
    render(
      <InstallCard
        build={build({
          platform: "ios",
          artifact_kind: "app",
          artifact_storage_uri:
            "r2://bucket/native-builds/ios/019a/HotUpdaterExample.app.zip",
        })}
      />,
    );

    expect(
      screen.getByText(`npx hot-updater native-build install ${id(1)}`),
    ).toBeTruthy();
  });

  it("says how an IPA installs over USB, with no TestFlight command", () => {
    const { container } = render(
      <InstallCard
        build={build({
          platform: "ios",
          artifact_kind: "ipa",
          artifact_storage_uri: "r2://bucket/native-builds/ios/019a/App.ipa",
        })}
      />,
    );

    expect(container.textContent).toContain(
      "Over USB, Xcode or Apple Configurator installs it.",
    );
    expect(container.textContent).not.toMatch(
      /For testers|hot-updater testflight/,
    );
    expect(screen.getByRole("link", { name: /Download App.ipa/ })).toBeTruthy();
  });
  it("gives a sandbox IPA no TestFlight advice, with or without a QR code", () => {
    const sandboxIpa = build({
      platform: "ios",
      artifact_kind: "ipa",
      artifact_storage_uri: "r2://bucket/native-builds/ios/019a/App.ipa",
      is_sandbox: true,
    });
    const { container } = render(<InstallCard build={sandboxIpa} />);

    expect(container.textContent).toContain("Over USB, Xcode");
    expect(container.textContent).not.toMatch(/TestFlight|For testers/);
    expect(screen.getByRole("link", { name: /Download App.ipa/ })).toBeTruthy();
    cleanup();

    unsigned(null);
    const { container: noQr } = render(<InstallCard build={sandboxIpa} />);
    expect(noQr.textContent).toMatch(/signing profile allows/);
    expect(noQr.textContent).not.toMatch(/TestFlight/);
  });
});

describe("a submitted build's page", () => {
  beforeEach(() => {
    downloadLinkQuery.mockReturnValue({ data: ISSUED_LINK });
  });

  it("keeps a sandbox build's TestFlight state", () => {
    render(
      <InstallCard
        build={build({
          platform: "ios",
          artifact_kind: "ipa",
          artifact_storage_uri: "r2://bucket/native-builds/ios/019a/App.ipa",
          is_sandbox: true,
          submitted_to: "testflight",
          submitted_at_ms: Date.now(),
          submitted_version: "1.7.0 (66)",
        })}
      />,
    );

    expect(screen.getByText(/On TestFlight as/).textContent).toContain(
      "1.7.0 (66)",
    );
    expect(
      screen.getByRole("link", { name: /Open App Store Connect/ }),
    ).toBeTruthy();
  });

  it("says where the store has it instead of how to upload it", () => {
    const ipa = build({
      platform: "ios",
      artifact_kind: "ipa",
      artifact_storage_uri: "r2://bucket/native-builds/ios/019a/App.ipa",
      submitted_to: "testflight",
      submitted_at_ms: Date.now(),
      submitted_version: "1.7.0 (66)",
    });
    render(
      <>
        <InstallCard build={ipa} />
        <BuiltInBundleCard
          detail={detail({ build: ipa, newestInScope: ipa })}
        />
      </>,
    );

    expect(screen.getByText(/On TestFlight as/).textContent).toContain(
      "1.7.0 (66)",
    );
    expect(screen.queryByText("npx hot-updater testflight")).toBeNull();
    expect(screen.getByText("Store")).toBeTruthy();
    // The store installs it: no QR code of the file, and no signed link read.
    expect(screen.queryByRole("img")).toBeNull();
    expect(downloadLinkQuery).not.toHaveBeenCalled();
    expect(
      screen.getByRole("link", { name: /Open App Store Connect/ }),
    ).toHaveProperty("href", "https://appstoreconnect.apple.com/apps");
  });

  it("shows no store line for a build no store took", () => {
    render(<BuiltInBundleCard detail={detail()} />);

    expect(screen.queryByText("Store")).toBeNull();
  });

  it.each(["play-closed", "play-open", "play-production"] as const)(
    "shows the Play Console link for %s",
    (submitted_to) => {
      render(
        <InstallCard build={build({ artifact_kind: "aab", submitted_to })} />,
      );
      if (submitted_to === "play-production") {
        expect(screen.queryByText(/Testers get it once/)).toBeNull();
      }
      expect(
        screen
          .getByRole("link", { name: /Open Play Console/ })
          .getAttribute("href"),
      ).toBe("https://play.google.com/console");
      expect(
        screen.getByText(
          new RegExp(`Submitted to Play ${submitted_to.slice(5)} as`),
        ),
      ).toBeTruthy();
    },
  );

  it("names Google Play for a submitted AAB", () => {
    render(
      <InstallCard
        build={build({
          artifact_kind: "aab",
          artifact_storage_uri:
            "r2://bucket/native-builds/android/019a/app.aab",
          submitted_to: "play-internal",
          submitted_at_ms: Date.now(),
          submitted_version: "1.7.0 (66)",
        })}
      />,
    );

    expect(
      screen.getByText(/Submitted to Google Play internal testing as/)
        .textContent,
    ).toContain("1.7.0 (66)");
    // A draft release isn't installable yet, so nothing says it is.
    expect(screen.getByText(/Submitted to Google Play/).textContent).toContain(
      "once its release is rolled out",
    );
    expect(
      screen.getByRole("link", { name: /Open Play Console/ }),
    ).toHaveProperty("href", "https://play.google.com/console");
  });
});

describe("an install card's download", () => {
  beforeEach(() => {
    downloadLinkQuery.mockReturnValue({ data: ISSUED_LINK });
  });

  /** The card's download, and whether it is the muted link, not a button. */
  const download = (file: string) => {
    const link = screen.getByRole("link", { name: `Download ${file}` });
    return {
      link,
      secondary: link.getAttribute("data-slot") === "secondary-download",
    };
  };

  it("keeps an APK's download a button, since an APK installs from its file", () => {
    const row = build();
    render(<InstallCard build={row} />);

    const { link, secondary } = download("app-release.apk");
    expect(secondary).toBe(false);
    expect(link.className).toContain("border-border");
    expect(link).toHaveProperty("href", signedUrl(row.id));
  });

  it.each([
    ["ipa", "ios", "App.ipa"],
    ["aab", "android", "app-release.aab"],
    ["app", "ios", "HotUpdaterExample.app.zip"],
  ] as const)(
    "makes an %s's download a muted link, keeping its signed link",
    (kind, platform, file) => {
      const row = build({
        platform,
        artifact_kind: kind,
        artifact_storage_uri: `r2://bucket/native-builds/${platform}/019a/${file}`,
      });
      render(<InstallCard build={row} />);

      const { link, secondary } = download(file);
      expect(secondary).toBe(true);
      expect(link.hasAttribute("download")).toBe(true);
      expect(link).toHaveProperty("href", signedUrl(row.id));
    },
  );

  it.each([
    ["testflight", "ios", "ipa", "App.ipa", "Open App Store Connect"],
    ["play-internal", "android", "aab", "app-release.aab", "Open Play Console"],
  ] as const)(
    "leaves the store the one button on a %s build, the download a link under it",
    (submitted_to, platform, kind, file, store) => {
      const row = build({
        platform,
        artifact_kind: kind,
        artifact_storage_uri: `r2://bucket/native-builds/${platform}/019a/${file}`,
        submitted_to,
        submitted_at_ms: Date.now(),
        submitted_version: "1.7.0 (66)",
      });
      render(<InstallCard build={row} />);

      const open = screen.getByRole("link", { name: store });
      const { link, secondary } = download(file);
      expect(secondary).toBe(true);
      expect(link.hasAttribute("download")).toBe(true);
      expect(link.getAttribute("href")).toBe(
        `/api/native-builds/${row.id}/download`,
      );
      // Under the store's button, not beside it in a row.
      expect(
        open.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(open.parentElement!.className).not.toContain("sm:flex-row");
    },
  );
});

describe("BuiltInBundleCard", () => {
  /** The value of the card's row labelled `label`. */
  const rowValue = (label: string) =>
    screen.getByText(label, { selector: "dt" }).nextElementSibling?.textContent;

  it("shows the target and the build key as the Native builds table does", () => {
    render(
      <BuiltInBundleCard
        detail={detail({
          build: build({
            build_key: `nbk1:a1b2c3d4${"0".repeat(52)}9f0e`,
            build_number: "121",
          }),
        })}
      />,
    );
    expect(rowValue("Build")).toBe("121");
    expect(rowValue("Target")).toBe("1a2b3c4d…9c0d");
    expect(rowValue("Build key")).toBe("a1b2c3d4…9f0e");
  });

  it("shows an app-version build's app version, and - for no build key", () => {
    render(
      <BuiltInBundleCard
        detail={detail({
          build: build({ fingerprint_hash: null, app_version: "1.4.2" }),
        })}
      />,
    );
    expect(rowValue("Target")).toBe("1.4.2");
    expect(rowValue("Build key")).toBe("-");
  });

  it("shows a fingerprint build's own app version over its fingerprint, as the table does, and names a newer build by it", () => {
    const newer = build({
      id: id(9),
      min_bundle_id: id(10),
      build_number: "122",
      native_app_version: "1.6.1",
    });
    render(
      <BuiltInBundleCard
        detail={detail({
          build: build({ native_app_version: "1.6.0" }),
          newestInScope: newer,
        })}
      />,
    );
    expect(rowValue("Target")).toBe("App version 1.6.01a2b3c4d…9c0d");
    // Named as the CLI names it: its version and build number.
    expect(
      screen.getByRole("link", { name: /Android 1\.6\.1 \(122\)/ }),
    ).toBeTruthy();
  });

  it("shows the built-in bundle, its patch count, and that new deploys patch from it", () => {
    render(<BuiltInBundleCard detail={detail()} />);

    expect(screen.getByText(id(2))).toBeTruthy();
    expect(screen.getByText("2 bundles")).toBeTruthy();
    expect(screen.getByText("Current baseline.")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Show the builds that embed pr-130" }),
    ).toHaveProperty(
      "href",
      expect.stringContaining("/native-builds?channel=pr-130"),
    );
  });

  it("links a build new deploys don't patch from to the newest one", () => {
    const newer = build({ id: id(9), min_bundle_id: id(10) });
    render(<BuiltInBundleCard detail={detail({ newestInScope: newer })} />);

    expect(screen.queryByText("Current baseline.")).toBeNull();
    expect(screen.getByText("Not the base.")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Android APK/ })).toHaveProperty(
      "href",
      expect.stringContaining(`/native-builds/${id(9)}`),
    );
    expect(
      screen.getByRole("button", { name: "Mark as store build" }),
    ).toBeTruthy();
  });

  it("links a build the mark passes over to the store build, even when it's the newest", () => {
    const store = build({
      id: id(9),
      min_bundle_id: id(10),
      is_store_build: true,
    });
    render(<BuiltInBundleCard detail={detail({ storeBuildInScope: store })} />);

    expect(screen.queryByText("Current baseline.")).toBeNull();
    expect(screen.getByText("Not the base.")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Android APK/ })).toHaveProperty(
      "href",
      expect.stringContaining(`/native-builds/${id(9)}`),
    );
  });

  it("names the base by app version and build number, as the CLI does", () => {
    const store = build({
      id: id(9),
      platform: "ios",
      artifact_kind: "ipa",
      app_version: "1.7.0",
      build_number: "66",
      min_bundle_id: id(10),
      is_store_build: true,
    });
    const newer = build({
      id: id(11),
      platform: "ios",
      artifact_kind: "ipa",
      app_version: "1.7.0",
      build_number: "67",
      min_bundle_id: id(12),
    });
    render(
      <BuiltInBundleCard
        detail={detail({
          build: newer,
          newestInScope: newer,
          storeBuildInScope: store,
        })}
      />,
    );

    expect(screen.getByRole("link", { name: "iOS 1.7.0 (66)" })).toHaveProperty(
      "href",
      expect.stringContaining(`/native-builds/${id(9)}`),
    );
  });

  it("names the base by the store's label when a store took it", () => {
    const store = build({
      id: id(9),
      submitted_version: "1.7.0 (66)",
      platform: "ios",
      artifact_kind: "ipa",
      is_store_build: true,
    });
    render(<BuiltInBundleCard detail={detail({ storeBuildInScope: store })} />);

    expect(screen.getByRole("link", { name: "iOS 1.7.0 (66)" })).toBeTruthy();
  });

  it("offers the mark on the newest build, and marks it in one press", () => {
    render(<BuiltInBundleCard detail={detail()} />);

    expect(screen.getByText("Current baseline.")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Mark as store build" }),
    );

    expect(markMutate).toHaveBeenCalledWith(
      { id: id(1), storeBuild: true },
      expect.anything(),
    );
  });

  it("says a marked build is the base, and clears it in one press", () => {
    const store = build({ is_store_build: true });
    render(
      <BuiltInBundleCard
        detail={detail({ build: store, storeBuildInScope: store })}
      />,
    );

    expect(screen.getByText("Store build.")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Mark as store build" }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Clear mark" }));

    expect(markMutate).toHaveBeenCalledWith(
      { id: id(1), storeBuild: false },
      expect.anything(),
    );
  });

  it("says new deploys don't patch from a sandbox build, whatever the scope's reads", () => {
    const sandbox = build({ is_sandbox: true });
    const { container } = render(
      <BuiltInBundleCard
        detail={detail({
          build: sandbox,
          newestInScope: sandbox,
          storeBuildInScope: null,
        })}
      />,
    );

    expect(screen.getByText("No patch base.")).toBeTruthy();
    expect(container.textContent).toContain(
      "Deploys make no patches from a sandbox build's built-in bundle.",
    );
    expect(container.textContent).not.toMatch(
      /Current baseline|Not the base|first OTA/,
    );
  });

  it("offers no mark on a sandbox build, by its record and not its channel", () => {
    render(
      <BuiltInBundleCard
        detail={detail({ build: build({ is_sandbox: true }) })}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "Mark as store build" }),
    ).toBeNull();
    cleanup();

    render(
      <BuiltInBundleCard
        detail={detail({
          build: build({
            channel_id: `channel:${encodeChannelKey("sandbox-release")}`,
          }),
          channel: "sandbox-release",
        })}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Mark as store build" }),
    ).toBeTruthy();
  });
});

describe("ServedNowCard", () => {
  const release = (bundleId: string, releaseId: string) => ({
    releaseId,
    kind: "BUNDLE" as const,
    bundleId,
    rolloutCohortCount: 1000,
    targetCohorts: [],
    shouldForceUpdate: false,
    message: `Release of ${bundleId}`,
  });

  it("gives a marked build the command for a newest OTA with no patch from it", () => {
    const store = build({ is_store_build: true });
    render(
      <ServedNowCard
        detail={detail({
          build: store,
          storeBuildInScope: store,
          servedNow: [release(id(20), id(120))],
          patches: patchPage([]),
        })}
      />,
    );

    expect(
      screen.getByText(
        `npx hot-updater patch -p android -c pr-130 -b ${id(20)} --base-artifact-id ${id(2)}`,
      ),
    ).toBeTruthy();
  });

  it("asks for the first OTA's patch past a newer release no install gets, quoted for the shell", () => {
    const store = build({
      is_store_build: true,
      channel_id: `channel:${encodeChannelKey("qa team;x")}`,
    });
    render(
      <ServedNowCard
        detail={detail({
          build: store,
          channel: "qa team;x",
          storeBuildInScope: store,
          servedNow: [
            { ...release(id(21), id(121)), rolloutCohortCount: 0 },
            release(id(20), id(120)),
          ],
          patches: patchPage([]),
        })}
      />,
    );

    expect(
      screen.getByText(
        `npx hot-updater patch -p android -c 'qa team;x' -b ${id(20)} --base-artifact-id ${id(2)}`,
      ),
    ).toBeTruthy();
  });

  it("asks for no patch when the newest OTA has one, or the build isn't marked", () => {
    const store = build({ is_store_build: true });
    render(
      <>
        <ServedNowCard
          detail={detail({
            build: store,
            storeBuildInScope: store,
            servedNow: [release(id(20), id(120)), release(id(19), id(119))],
            patches: patchPage([id(20)]),
          })}
        />
        <ServedNowCard
          detail={detail({
            servedNow: [release(id(20), id(120))],
            patches: patchPage([]),
          })}
        />
      </>,
    );

    expect(screen.queryByText(/npx hot-updater patch/)).toBeNull();
  });

  it("says how each served bundle's first OTA downloads on this build", () => {
    render(
      <ServedNowCard
        detail={detail({
          servedNow: [release(id(20), id(120)), release(id(19), id(119))],
          patches: patchPage([id(20)]),
        })}
      />,
    );

    const rows = screen.getAllByRole("row").slice(1);
    expect(rows[0]!.textContent).toContain("Patch");
    expect(rows[0]!.textContent).toContain("40.0 KB");
    expect(rows[1]!.textContent).toContain("Full bundle");
    expect(screen.getByRole("link", { name: id(20) })).toHaveProperty(
      "href",
      expect.stringContaining(`/?releaseId=${id(120)}`),
    );
    expect(
      screen.getByRole("link", { name: /All releases in this scope/ }),
    ).toHaveProperty("href", expect.stringContaining("scopeKey="));
  });

  it("offers the scope's releases when the build is served nothing", () => {
    render(<ServedNowCard detail={detail()} />);

    expect(screen.getByText("No OTA for this build yet")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "All releases in this scope" }),
    ).toBeTruthy();
  });
});

describe("firstDownloadOf", () => {
  it("is exact down to the patch page's oldest, and unknown past a full page", () => {
    const full = patchPage([id(30), id(25)], id(25));
    expect(firstDownloadOf(full, id(30))).toEqual({
      kind: "patch",
      byteSize: 40_960,
    });
    // Newer than the page's oldest and not in it: no patch exists.
    expect(firstDownloadOf(full, id(27))).toEqual({ kind: "full" });
    expect(firstDownloadOf(full, id(21))).toEqual({ kind: "unknown" });
    // A page that isn't full holds every patch.
    expect(firstDownloadOf(patchPage([id(25)]), id(21))).toEqual({
      kind: "full",
    });
  });
});

describe("PatchesCard", () => {
  it("lists the newest page it came with and reads no other", () => {
    patchesQuery.mockReturnValue({ data: undefined });
    render(
      <PatchesCard
        detail={detail({ patches: patchPage([id(40)], id(40)) })}
        onPage={vi.fn()}
        page={{}}
      />,
    );

    expect(screen.getByRole("link", { name: id(40) })).toHaveProperty(
      "href",
      expect.stringContaining(`/?bundleId=${id(40)}`),
    );
    expect(patchesQuery).toHaveBeenCalledWith(id(2), {}, false);
  });

  it("says what adds a patch when there is none", () => {
    patchesQuery.mockReturnValue({ data: undefined });
    render(<PatchesCard detail={detail()} onPage={vi.fn()} page={{}} />);

    expect(screen.getByText("No patches from this build")).toBeTruthy();
  });

  it("says a sandbox build gets no patches, with no guide to adding one", () => {
    patchesQuery.mockReturnValue({ data: undefined });
    const { container } = render(
      <PatchesCard
        detail={detail({ build: build({ is_sandbox: true }) })}
        onPage={vi.fn()}
        page={{}}
      />,
    );

    expect(screen.getByText("No patches from this build")).toBeTruthy();
    expect(container.textContent).toContain(
      "Deploys make no patches from a sandbox build's built-in bundle.",
    );
    expect(container.textContent).not.toMatch(/store build|newest build/);
    expect(
      screen.queryByRole("link", { name: /Bundle diffing guide/ }),
    ).toBeNull();
  });
});
