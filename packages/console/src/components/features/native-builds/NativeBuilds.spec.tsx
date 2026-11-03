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
  installEligibilityQuery,
  markMutate,
  patchesQuery,
  navigate,
} = vi.hoisted(() => ({
  downloadLinkQuery: vi.fn(),
  downloadUrlQuery: vi.fn(),
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
  store_build: null,
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
  const builds = (data: readonly NativeBuildRow[], page = {}) => ({
    data: { data, ...page },
    isError: false,
    isLoading: false,
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
        builds={builds([build({ store_build: true }), build({ id: id(3) })])}
        channel={undefined}
        onChannel={vi.fn()}
        paged={false}
      />,
    );

    expect(screen.getAllByText("Store build")).toHaveLength(1);
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
      "Actions",
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
    expect(
      screen.getByRole("link", { name: "Download app-release.apk" }),
    ).toHaveProperty(
      "href",
      expect.stringContaining(`/api/native-builds/${row.id}/download`),
    );

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

  it("shows each build as a compact card at 390 px: what and where, then when, then target and build key, then store", () => {
    const width = window.innerWidth;
    window.innerWidth = 390;
    try {
      const row = build({
        build_key: `nbk1:a1b2c3d4${"0".repeat(52)}9f0e`,
        build_number: "66",
        submitted_to: "play-internal",
        submitted_at_ms: Date.now(),
        submitted_version: "1.3.0 (66)",
        store_build: true,
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
      const [primary, meta, hashes, store] = [...card.children];
      expect(
        within(primary as HTMLElement).getByRole("link", {
          name: "Android APK",
        }).textContent,
      ).toBe("APK");
      expect(
        within(primary as HTMLElement).getByRole("button", {
          name: "Show the builds that embed pr-130",
        }),
      ).toBeTruthy();
      expect(
        within(primary as HTMLElement).getByRole("link", {
          name: "Download app-release.apk",
        }),
      ).toBeTruthy();
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
      expect(card.children).toHaveLength(3);
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
        builds={builds([build()], { next: id(9), previous: id(8) })}
        channel="pr-130"
        onChannel={vi.fn()}
        paged
      />,
    );

    const pages = screen.getByRole("navigation", {
      name: "Native build pages",
    });
    expect(pages.textContent).toContain("1 entry, newest first");
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
          ...builds([build()], { next: id(9), previous: id(8) }),
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
      [/Scan with an iPhone/g, /registered device/g, /Apple Configurator/g],
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

  it("keeps an IPA's TestFlight command beside its QR code", () => {
    render(
      <InstallCard
        build={build({
          platform: "ios",
          artifact_kind: "ipa",
          artifact_storage_uri: "r2://bucket/native-builds/ios/019a/App.ipa",
        })}
      />,
    );

    expect(screen.getByText(/For testers/)).toBeTruthy();
    expect(screen.getByText("npx hot-updater testflight")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Download App.ipa/ })).toBeTruthy();
  });
});

describe("a submitted build's page", () => {
  beforeEach(() => {
    downloadLinkQuery.mockReturnValue({ data: ISSUED_LINK });
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
      store_build: true,
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
      store_build: true,
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
      store_build: true,
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
    const store = build({ store_build: true });
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

  it("offers no mark on a sandbox channel's build", () => {
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
      screen.queryByRole("button", { name: "Mark as store build" }),
    ).toBeNull();
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
    const store = build({ store_build: true });
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
      store_build: true,
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
    const store = build({ store_build: true });
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
});
