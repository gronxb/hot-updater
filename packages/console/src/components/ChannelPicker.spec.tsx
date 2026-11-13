import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChannelPicker } from "./ChannelPicker";

const mocks = vi.hoisted(() => ({
  channels: undefined as { name: string }[] | undefined,
  isPending: false,
  isError: false,
  refetch: vi.fn(),
}));
vi.mock("@/lib/api", () => ({
  useChannelsQuery: () => ({
    data: mocks.channels,
    isPending: mocks.isPending,
    isError: mocks.isError,
    refetch: mocks.refetch,
  }),
}));

beforeEach(() => {
  mocks.channels = [
    { name: "production" },
    { name: "pr-134" },
    { name: "qa-rc29-second-ota-20261003" },
    { name: "sandbox-sandboxAdhoc" },
  ];
  mocks.isPending = false;
  mocks.isError = false;
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const renderPicker = (props: Partial<ComponentProps<typeof ChannelPicker>>) => {
  const onValueChange = vi.fn();
  render(
    <ChannelPicker
      onValueChange={onValueChange}
      value="production"
      {...props}
    />,
  );
  return { onValueChange };
};
const open = () =>
  fireEvent.click(screen.getByRole("combobox", { name: /^Channel/ }));
const type = async (value: string) => {
  const search = await screen.findByRole("combobox", {
    name: "Search channels",
  });
  act(() => search.focus());
  fireEvent.input(search, { inputType: "insertText", target: { value } });
  return search;
};
const options = () =>
  screen.getAllByRole("option").map((option) => option.textContent);

describe("ChannelPicker", () => {
  it("names the channel on its button and reads the list again as it opens", async () => {
    renderPicker({});
    expect(
      screen
        .getByRole("combobox", { name: /^Channel/ })
        .getAttribute("aria-label"),
    ).toBe("Channel: production");
    open();
    await screen.findByRole("combobox", { name: "Search channels" });
    expect(mocks.refetch).toHaveBeenCalledOnce();
  });

  it("narrows the list as a channel is typed, and Enter picks the first match", async () => {
    const { onValueChange } = renderPicker({ allChannels: true });
    open();
    const search = await type("PR-1");
    expect(options()).toEqual(["pr-134"]);
    fireEvent.keyDown(search, { key: "Enter" });
    expect(onValueChange).toHaveBeenLastCalledWith("pr-134");
  });

  it("offers All channels only where asked, as no channel's name", async () => {
    const { onValueChange } = renderPicker({ allChannels: true });
    open();
    await screen.findByRole("combobox", { name: "Search channels" });
    expect(options()[0]).toBe("All channels");
    const all = screen.getByRole("option", { name: "All channels" });
    await act(async () => {
      fireEvent.pointerDown(all);
      fireEvent.click(all);
    });
    expect(onValueChange).toHaveBeenLastCalledWith(undefined);

    cleanup();
    renderPicker({});
    open();
    await screen.findByRole("combobox", { name: "Search channels" });
    expect(options()).not.toContain("All channels");
  });

  it("keeps a linked channel the list doesn't hold yet as a choice", async () => {
    renderPicker({ value: "pr-200" });
    open();
    await screen.findByRole("combobox", { name: "Search channels" });
    expect(options()[0]).toBe("pr-200");
  });

  it("shows a long channel name whole, unclipped", async () => {
    renderPicker({});
    open();
    const option = await screen.findByRole("option", {
      name: "qa-rc29-second-ota-20261003",
    });
    const name = option.querySelector("span:not([data-slot])")!;
    expect(name.className).toContain("[overflow-wrap:anywhere]");
    expect(name.className).not.toContain("truncate");
  });

  it("offers to clear a search that matches no channel", async () => {
    renderPicker({});
    open();
    await type("nothing-like-this");
    expect(
      screen.getByText("No channel matches “nothing-like-this”."),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(
      (
        screen.getByRole("combobox", {
          name: "Search channels",
        }) as HTMLInputElement
      ).value,
    ).toBe("");
    expect(options()).toContain("production");
  });

  it("says the list is loading, and offers to read it again when it fails", async () => {
    mocks.channels = undefined;
    mocks.isPending = true;
    renderPicker({});
    open();
    expect(await screen.findByText("Loading channels…")).toBeTruthy();
    cleanup();

    mocks.isPending = false;
    mocks.isError = true;
    renderPicker({});
    open();
    const retry = await screen.findByRole("button", { name: "Retry channels" });
    mocks.refetch.mockClear();
    fireEvent.click(retry);
    expect(mocks.refetch).toHaveBeenCalledOnce();
  });

  it("waits, closed, while the page decides its channel", () => {
    renderPicker({ pending: true, value: undefined, allChannels: true });
    const trigger = screen.getByRole("combobox", { name: "Channel" });
    expect(trigger.hasAttribute("disabled")).toBe(true);
    expect(trigger.textContent).not.toContain("All channels");
  });

  it("keeps 44 px rows and a 16 px search on a phone", async () => {
    renderPicker({});
    open();
    const search = await screen.findByRole("combobox", {
      name: "Search channels",
    });
    expect(search.className).toContain("max-md:text-base");
    expect(search.closest("[data-slot=combobox-content]")!.className).toContain(
      "max-md:*:data-[slot=input-group]:h-11",
    );
    expect(
      screen.getByRole("option", { name: "production" }).className,
    ).toContain("max-md:min-h-11");
  });
});
