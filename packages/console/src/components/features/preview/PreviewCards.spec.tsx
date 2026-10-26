import type { NativeBuildRow } from "@hot-updater/plugin-core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChannelLinkCard } from "./ChannelLinkCard";
import { InstallBuildDialog } from "./InstallBuildDialog";
import { NativeBuildsCard } from "./NativeBuildsCard";

const { downloadUrlQuery, buildQuery } = vi.hoisted(() => ({
  downloadUrlQuery: vi.fn(),
  buildQuery: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  useConfigQuery: () => ({ data: { console: {} } }),
  useNativeBuildDownloadUrlQuery: downloadUrlQuery,
  useNativeBuildQuery: buildQuery,
}));

vi.mock("@/components/ui/dialog", () => {
  const Wrapper = ({ children }: { children: ReactNode }) => <>{children}</>;
  return {
    Dialog: ({ children, open }: { children: ReactNode; open: boolean }) =>
      open ? <div role="dialog">{children}</div> : null,
    DialogContent: Wrapper,
    DialogDescription: ({ children }: { children: ReactNode }) => (
      <p>{children}</p>
    ),
    DialogHeader: Wrapper,
    DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  };
});

const build = (overrides: Partial<NativeBuildRow> = {}): NativeBuildRow => ({
  id: "019a0000-0000-7000-8000-000000000001",
  scope_key: "scope",
  platform: "android",
  channel_id: "channel:cHJldmlldw",
  fingerprint_hash: null,
  app_version: "1.0",
  min_bundle_id: "019a0000-0000-7000-8000-000000000002",
  artifact_kind: "apk",
  artifact_storage_uri:
    "r2://bucket/native-builds/android/019a/app-release.apk",
  byte_size: 52_428_800,
  git_commit_hash: "abcdef1234567",
  created_at_ms: 0,
  build_key: null,
  ...overrides,
});

const channelName = () => "preview";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("NativeBuildsCard", () => {
  const builds = (data: readonly NativeBuildRow[], page = {}) => ({
    data: { data, ...page },
    isError: false,
    isLoading: false,
    isPlaceholderData: false,
    refetch: vi.fn(),
  });

  it("lists each build with its artifact, target, and channel, and opens its install", () => {
    const onInstall = vi.fn();
    const row = build();
    render(
      <NativeBuildsCard
        builds={builds([row], { next: row.id })}
        channelName={channelName}
        paged={false}
        onInstall={onInstall}
        onPage={vi.fn()}
      />,
    );

    expect(screen.getByText("APK")).toBeTruthy();
    expect(screen.getByText("50.0 MB")).toBeTruthy();
    expect(screen.getByText("App version")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Install the Android build of preview",
      }),
    );
    expect(onInstall).toHaveBeenCalledWith(row);
    expect(
      (screen.getByRole("button", { name: /Newer/ }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("gives an empty registry the command that registers a build", () => {
    render(
      <NativeBuildsCard
        builds={builds([])}
        channelName={channelName}
        paged={false}
        onInstall={vi.fn()}
        onPage={vi.fn()}
      />,
    );

    expect(screen.getByText("No native builds")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: /Native build guide/ }),
    ).toHaveProperty(
      "href",
      "https://hot-updater.dev/docs/guides/native-build#register-a-build",
    );
  });

  it("leads an empty older page back to the newest builds", () => {
    const onPage = vi.fn();
    render(
      <NativeBuildsCard
        builds={builds([])}
        channelName={channelName}
        paged
        onInstall={vi.fn()}
        onPage={onPage}
      />,
    );

    expect(screen.getByText("No more native builds")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Show the newest builds" }),
    );
    expect(onPage).toHaveBeenCalledWith({});
  });
});

describe("InstallBuildDialog", () => {
  it("shows an APK's storage URL as a QR code and downloads through the console", () => {
    const row = build();
    buildQuery.mockReturnValue({ data: row, isLoading: false });
    downloadUrlQuery.mockReturnValue({
      data: { url: "https://r2.example.com/app-release.apk?sig=1" },
    });
    render(
      <InstallBuildDialog
        buildId={row.id}
        channelName={channelName}
        listed={row}
        onClose={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("img", { name: "Download app-release.apk" }),
    ).toBeTruthy();
    expect(downloadUrlQuery).toHaveBeenCalledWith(row.id, true);
    expect(
      screen.getByRole("link", { name: /Download app-release.apk/ }),
    ).toHaveProperty(
      "href",
      expect.stringContaining(`/api/native-builds/${row.id}/download`),
    );
  });

  it("shows no QR code when the storage has no download URL a phone can open", () => {
    const row = build();
    buildQuery.mockReturnValue({ data: row, isLoading: false });
    downloadUrlQuery.mockReturnValue({ data: { url: null } });
    render(
      <InstallBuildDialog
        buildId={row.id}
        channelName={channelName}
        listed={row}
        onClose={vi.fn()}
      />,
    );

    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByText(/there is no QR code/)).toBeTruthy();
    expect(
      screen.getByRole("link", { name: /Download app-release.apk/ }),
    ).toBeTruthy();
  });

  it("gives a simulator app its install command and reads no download URL", () => {
    const row = build({
      platform: "ios",
      artifact_kind: "app",
      artifact_storage_uri:
        "r2://bucket/native-builds/ios/019a/HotUpdaterExample.app.zip",
    });
    buildQuery.mockReturnValue({ data: row, isLoading: false });
    render(
      <InstallBuildDialog
        buildId={row.id}
        channelName={channelName}
        listed={row}
        onClose={vi.fn()}
      />,
    );

    expect(
      screen.getByText(
        "unzip -o HotUpdaterExample.app.zip && xcrun simctl install booted HotUpdaterExample.app",
      ),
    ).toBeTruthy();
    expect(downloadUrlQuery).not.toHaveBeenCalled();
  });

  it("says when a linked build is not in the registry", () => {
    buildQuery.mockReturnValue({ data: null, isLoading: false });
    render(
      <InstallBuildDialog
        buildId="missing"
        channelName={channelName}
        listed={undefined}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText("Build not found")).toBeTruthy();
  });
});

describe("ChannelLinkCard", () => {
  const channels = {
    data: ["preview", "pr-12"],
    isError: false,
    isPending: false,
    refetch: vi.fn(),
  };

  it("shows the chosen channel's link as a QR code and the commands that open it", () => {
    render(
      <ChannelLinkCard
        channel="pr-12"
        channels={channels}
        onChannelChange={vi.fn()}
        prefix="myapp://"
        prefixPending={false}
      />,
    );

    expect(
      screen.getByRole("img", { name: "Switch to the pr-12 channel" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("link", { name: /Open in the app/ }),
    ).toHaveProperty("href", "myapp://hot-updater/channel/pr-12");
    expect(
      screen.getByText(
        "xcrun simctl openurl booted myapp://hot-updater/channel/pr-12",
      ),
    ).toBeTruthy();
  });

  it("reads the channels again when the list opens", async () => {
    const refetch = vi.fn();
    render(
      <ChannelLinkCard
        channel={undefined}
        channels={{ ...channels, refetch }}
        onChannelChange={vi.fn()}
        prefix="myapp://"
        prefixPending={false}
      />,
    );

    const trigger = screen
      .getByLabelText("Channel")
      .parentElement?.querySelector("button");
    if (!trigger) throw new Error("The channel list has no trigger.");
    fireEvent.click(trigger);
    expect(await screen.findByRole("option", { name: "pr-12" })).toBeTruthy();
    expect(refetch).toHaveBeenCalled();
  });

  it("names the config option when the console has no link prefix", () => {
    render(
      <ChannelLinkCard
        channel="pr-12"
        channels={channels}
        onChannelChange={vi.fn()}
        prefix={undefined}
        prefixPending={false}
      />,
    );

    expect(screen.getByText("Set the app's link prefix")).toBeTruthy();
    expect(screen.getByText("console.channelLinkPrefix")).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
  });
});
