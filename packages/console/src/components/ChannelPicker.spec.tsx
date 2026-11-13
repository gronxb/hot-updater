import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { type ComponentProps, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CHANNELS_FRESH_MS, ChannelPicker } from "./ChannelPicker";

const mocks = vi.hoisted(() => ({
  channels: undefined as { name: string }[] | undefined,
  /** When the cached list was read. */
  dataUpdatedAt: 0,
  isPending: false,
  isError: false,
  refetch: vi.fn(),
}));
vi.mock("@/lib/api", () => ({
  useChannelsQuery: () => ({
    data: mocks.channels,
    dataUpdatedAt: mocks.dataUpdatedAt,
    isFetching: false,
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
  mocks.dataUpdatedAt = Date.now();
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
/** The options the list reports as selected. */
const selectedOptions = () =>
  screen
    .getAllByRole("option")
    .filter((option) => option.getAttribute("aria-selected") === "true")
    .map((option) => option.textContent);
const pick = async (name: string) => {
  const option = await screen.findByRole("option", { name });
  await act(async () => {
    fireEvent.pointerDown(option);
    fireEvent.click(option);
  });
};
/** A page that keeps what the picker chose, as the URL does. */
function Page({ initial }: { readonly initial: string | undefined }) {
  const [value, setValue] = useState(initial);
  return <ChannelPicker allChannels onValueChange={setValue} value={value} />;
}
const frames = (count: number) =>
  act(async () => {
    for (let index = 0; index < count; index += 1) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  });

describe("ChannelPicker", () => {
  it("names the channel on its button and selects it in the list", async () => {
    renderPicker({});
    expect(
      screen
        .getByRole("combobox", { name: /^Channel/ })
        .getAttribute("aria-label"),
    ).toBe("Channel: production");
    open();
    await screen.findByRole("combobox", { name: "Search channels" });
    expect(selectedOptions()).toEqual(["production"]);
    // The primitive's check marks the selected channel, and only it.
    expect(
      screen
        .getAllByRole("option")
        .map((option) => option.querySelector("svg") !== null),
    ).toEqual([true, false, false, false]);
  });

  it("shows the cached list as it opens, and reads it again once it's old", async () => {
    renderPicker({});
    open();
    await screen.findByRole("combobox", { name: "Search channels" });
    expect(mocks.refetch).not.toHaveBeenCalled();
    cleanup();

    mocks.dataUpdatedAt = Date.now() - CHANNELS_FRESH_MS - 1;
    renderPicker({});
    open();
    await screen.findByRole("combobox", { name: "Search channels" });
    expect(mocks.refetch).toHaveBeenCalledOnce();
  });

  it.each([
    ["production", "production"],
    [undefined, "All channels"],
    ["all", "all"],
  ])(
    "selects exactly one option for %s, and after picking and reopening",
    async (initial, label) => {
      mocks.channels = [
        { name: "all" },
        { name: "production" },
        { name: "pr-134" },
      ];
      render(<Page initial={initial} />);
      open();
      await screen.findByRole("combobox", { name: "Search channels" });
      expect(selectedOptions()).toEqual([label]);

      // Pick each of the others in turn: one selection follows every pick.
      for (const next of ["all", "All channels", "production"]) {
        if (next === label) continue;
        if (!screen.queryByRole("listbox")) open();
        await pick(next);
        open();
        await screen.findByRole("combobox", { name: "Search channels" });
        expect(selectedOptions()).toEqual([next]);
        expect(
          screen
            .getByRole("combobox", { name: /^Channel/ })
            .getAttribute("aria-label"),
        ).toBe(`Channel: ${next}`);
      }
    },
  );

  it("opens scrolled to its first item, though the selected channel is far down", async () => {
    // A browser scrolls the list to the highlighted item; jsdom doesn't.
    const scrollIntoView = vi.fn(function (this: Element) {
      this.closest("[data-slot=combobox-list]")!.scrollTop = 500;
    });
    Element.prototype.scrollIntoView = scrollIntoView;
    try {
      mocks.channels = Array.from({ length: 40 }, (_, index) => ({
        name: `pr-${100 + index}`,
      })).concat({ name: "production" });
      renderPicker({});
      open();
      await screen.findByRole("combobox", { name: "Search channels" });
      await frames(3);
      expect(scrollIntoView).toHaveBeenCalled();
      const list = document.querySelector("[data-slot=combobox-list]")!;
      expect(list.scrollTop).toBe(0);
      expect(selectedOptions()).toEqual(["production"]);
    } finally {
      delete (Element.prototype as Partial<Element>).scrollIntoView;
    }
  });

  it("returns focus to its button after a pick and after Escape", async () => {
    renderPicker({ allChannels: true });
    const trigger = screen.getByRole("combobox", { name: /^Channel/ });
    open();
    await pick("pr-134");
    await frames(2);
    expect(document.activeElement).toBe(trigger);

    open();
    const search = await screen.findByRole("combobox", {
      name: "Search channels",
    });
    fireEvent.keyDown(search, { key: "Escape" });
    await frames(2);
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.activeElement).toBe(trigger);
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
    fireEvent.click(retry);
    expect(mocks.refetch).toHaveBeenCalledOnce();
  });

  it("waits, closed, while the page decides its channel", () => {
    renderPicker({ pending: true, value: undefined, allChannels: true });
    const trigger = screen.getByRole("combobox", { name: "Channel" });
    expect(trigger.hasAttribute("disabled")).toBe(true);
    expect(trigger.textContent).not.toContain("All channels");
    expect(trigger.querySelector("[data-slot=skeleton]")).not.toBeNull();
    cleanup();

    // A failed list leaves the page's alert to say so, with no pulse here.
    mocks.channels = undefined;
    mocks.isError = true;
    renderPicker({ pending: true, value: undefined, allChannels: true });
    expect(
      screen
        .getByRole("combobox", { name: "Channel" })
        .querySelector("[data-slot=skeleton]"),
    ).toBeNull();
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
