import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CHANNELS_FRESH_MS, ChannelPicker } from "./ChannelPicker";

// The channel list's one server read; the query around it is the real one.
const rpc = vi.hoisted(() => ({ getChannels: vi.fn() }));
vi.mock("@/lib/api-rpc", () => rpc);

const channel = (name: string) => ({ id: `channel:${name}`, name });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-13T00:00:00Z"));
  rpc.getChannels.mockResolvedValue([channel("production"), channel("pr-134")]);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

const trigger = () => screen.getByRole("combobox", { name: /^Channel/ });
const open = async () => {
  fireEvent.click(trigger());
  return screen.findByRole("combobox", { name: "Search channels" });
};

describe("ChannelPicker's channel reads", () => {
  it("reads the list once while it is fresh, and again when it opens old", async () => {
    const onValueChange = vi.fn();
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <ChannelPicker onValueChange={onValueChange} value="production" />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(rpc.getChannels).toHaveBeenCalledOnce());

    // Open, close, reopen, type, and pick: all from the cached list.
    let search = await open();
    fireEvent.keyDown(search, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
    search = await open();
    act(() => search.focus());
    fireEvent.input(search, {
      inputType: "insertText",
      target: { value: "pr-" },
    });
    const option = await screen.findByRole("option", { name: "pr-134" });
    await act(async () => {
      fireEvent.pointerDown(option);
      fireEvent.click(option);
    });
    expect(onValueChange).toHaveBeenLastCalledWith("pr-134");
    vi.setSystemTime(Date.now() + CHANNELS_FRESH_MS - 1_000);
    search = await open();
    fireEvent.keyDown(search, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
    expect(rpc.getChannels).toHaveBeenCalledOnce();

    // Past the bound, opening reads the list once, and a pull request's
    // new channel shows up without a reload.
    rpc.getChannels.mockResolvedValue([
      channel("production"),
      channel("pr-134"),
      channel("pr-200"),
    ]);
    vi.setSystemTime(Date.now() + CHANNELS_FRESH_MS + 1_000);
    await open();
    expect(await screen.findByRole("option", { name: "pr-200" })).toBeTruthy();
    expect(rpc.getChannels).toHaveBeenCalledTimes(2);
  });
});
