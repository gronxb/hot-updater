import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NativeBuildsPage } from "./NativeBuildsPage";

const DEFAULT_CHANNELS = [
  { id: "channel:all", name: "all" },
  { id: "channel:pr-130", name: "pr-130" },
];
const mocks = vi.hoisted(() => ({
  /** The channel list the page already reads; undefined while it loads. */
  channels: undefined as { id: string; name: string }[] | undefined,
  /** Whether the channel list's last read failed. */
  channelsError: false,
  refetchChannels: vi.fn(),
  nativeBuildsQuery: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  useChannelsQuery: () => ({
    data: mocks.channels,
    isError: mocks.channelsError,
    refetch: mocks.refetchChannels,
  }),
  useConfigQuery: () => ({ data: { console: {} } }),
  useNativeBuildsQuery: mocks.nativeBuildsQuery,
}));
vi.mock("@/components/ui/sidebar", () => ({
  SidebarTrigger: () => null,
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  useNavigate: () => vi.fn(),
}));

beforeEach(() => {
  mocks.channels = DEFAULT_CHANNELS;
  mocks.channelsError = false;
  // A query that may not run yet is pending, as TanStack Query's is.
  mocks.nativeBuildsQuery.mockImplementation((_, options) => ({
    data: options?.enabled === false ? undefined : { entries: [] },
    isError: false,
    isPending: options?.enabled === false,
    isPlaceholderData: false,
    refetch: vi.fn(),
  }));
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** Every page of builds the page read: the ones it asked to run. */
const reads = () =>
  mocks.nativeBuildsQuery.mock.calls
    .filter(([, options]) => (options?.enabled ?? true) === true)
    .map(([page]) => page);

const choose = async (option: string) => {
  fireEvent.click(screen.getByRole("combobox", { name: "Channel" }));
  const item = await screen.findByRole("option", { name: option });
  fireEvent.pointerDown(item);
  fireEvent.click(item);
};

describe("NativeBuildsPage", () => {
  it("shows the CLI command that imports a build made elsewhere, and uploads nothing", async () => {
    render(<NativeBuildsPage onSearchChange={vi.fn()} search={{}} />);

    fireEvent.click(screen.getByRole("button", { name: "Import a build" }));

    const dialog = await screen.findByRole("dialog");
    // A title, one line, the command, and the guide: nothing else.
    expect(
      [...dialog.querySelectorAll("h2, p, code, a")].map(
        (element) => element.textContent,
      ),
    ).toEqual([
      "Import a build",
      "Track an .ipa, .aab, .apk or .app built elsewhere as a patch base.",
      "npx hot-updater native-build import <file>",
      "Import guide",
    ]);
    expect(screen.getByRole("link", { name: /Import guide/ })).toHaveProperty(
      "href",
      "https://hot-updater.dev/docs/guides/native-build#import-a-build-made-elsewhere",
    );
    expect(
      screen.getByRole("button", { name: "Copy the import command" }),
    ).toBeTruthy();
    expect(document.querySelector('input[type="file"]')).toBeNull();
  });

  it("filters by a channel named all, apart from all channels", async () => {
    const onSearchChange = vi.fn();
    render(<NativeBuildsPage onSearchChange={onSearchChange} search={{}} />);

    await choose("all");
    expect(onSearchChange).toHaveBeenLastCalledWith({ channel: "all" });
  });

  it("clears the filter with All channels, and shows a channel named all as chosen", async () => {
    const onSearchChange = vi.fn();
    render(
      <NativeBuildsPage
        onSearchChange={onSearchChange}
        search={{ channel: "all" }}
      />,
    );

    const trigger = screen.getByRole("combobox", { name: "Channel" });
    expect(trigger.textContent).toContain("all");
    expect(trigger.textContent).not.toContain("All channels");
    await choose("All channels");
    expect(onSearchChange).toHaveBeenLastCalledWith({ channels: "all" });
  });

  describe("default channel", () => {
    beforeEach(() => {
      mocks.channels = [
        { id: "channel:pr-130", name: "pr-130" },
        { id: "channel:production", name: "production" },
      ];
    });

    it("opens on production when the URL names no channel, and reads no other page", () => {
      render(<NativeBuildsPage onSearchChange={vi.fn()} search={{}} />);

      expect(reads()).toEqual([{ channel: "production" }]);
      expect(
        screen.getByRole("combobox", { name: "Channel" }).textContent,
      ).toContain("production");
    });

    it("reads nothing until the channel list it already loads arrives", () => {
      mocks.channels = undefined;
      render(<NativeBuildsPage onSearchChange={vi.fn()} search={{}} />);

      expect(mocks.nativeBuildsQuery).toHaveBeenCalled();
      expect(reads()).toEqual([]);
      expect(screen.queryByText("No native builds")).toBeNull();
    });

    it("lists every channel when the URL says so", () => {
      render(
        <NativeBuildsPage
          onSearchChange={vi.fn()}
          search={{ channels: "all", before: "b" }}
        />,
      );

      expect(reads()).toEqual([{ before: "b" }]);
      expect(
        screen.getByRole("combobox", { name: "Channel" }).textContent,
      ).toContain("All channels");
    });

    it("reads no builds when the channel list fails, and offers to read it again", () => {
      mocks.channels = undefined;
      mocks.channelsError = true;
      render(<NativeBuildsPage onSearchChange={vi.fn()} search={{}} />);

      expect(reads()).toEqual([]);
      expect(screen.getByText("Channels couldn't be loaded")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      expect(mocks.refetchChannels).toHaveBeenCalled();
    });

    it("keeps production when a refresh of a loaded channel list fails", () => {
      mocks.channelsError = true;
      render(<NativeBuildsPage onSearchChange={vi.fn()} search={{}} />);

      expect(reads()).toEqual([{ channel: "production" }]);
      expect(screen.queryByText("Channels couldn't be loaded")).toBeNull();
    });

    it("reads a linked channel while the channel list fails", () => {
      mocks.channels = undefined;
      mocks.channelsError = true;
      render(
        <NativeBuildsPage
          onSearchChange={vi.fn()}
          search={{ channel: "pr-130" }}
        />,
      );

      expect(reads()).toEqual([{ channel: "pr-130" }]);
    });

    it("lists every channel when the project has no production channel", () => {
      mocks.channels = DEFAULT_CHANNELS;
      render(<NativeBuildsPage onSearchChange={vi.fn()} search={{}} />);

      expect(reads()).toEqual([{}]);
    });

    it("keeps an inbound channel link where it points", () => {
      render(
        <NativeBuildsPage
          onSearchChange={vi.fn()}
          search={{ channel: "pr-130" }}
        />,
      );

      expect(reads()).toEqual([{ channel: "pr-130" }]);
    });

    it("shows every channel from an empty production list", () => {
      const onSearchChange = vi.fn();
      render(<NativeBuildsPage onSearchChange={onSearchChange} search={{}} />);

      fireEvent.click(
        screen.getByRole("button", { name: "Show all channels" }),
      );
      expect(onSearchChange).toHaveBeenLastCalledWith({ channels: "all" });
    });
  });
});
