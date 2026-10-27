import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AdoptionRelease } from "@/lib/release-adoption";

import { InsightsControls } from "./InsightsControls";

const mocks = vi.hoisted(() => ({ channels: vi.fn() }));
vi.mock("@/lib/api", () => ({ useChannelsQuery: mocks.channels }));

const release = (
  releaseId: string,
  overrides: Partial<AdoptionRelease> = {},
): AdoptionRelease => ({
  releaseId,
  bundleId: `bundle-${releaseId}`,
  platform: "ios",
  deployedAtMs: 0,
  targetAppVersion: "1.6.x",
  enabled: true,
  live: true,
  revision: 1,
  ...overrides,
});

const renderControls = (
  props: Partial<ComponentProps<typeof InsightsControls>> = {},
) => {
  const onFiltersChange = vi.fn();
  const view = render(
    <QueryClientProvider client={new QueryClient()}>
      <InsightsControls
        filters={{ channel: "production", platform: "all" }}
        appVersions={["1.0.0", "2.0.0"]}
        releases={[]}
        onFiltersChange={onFiltersChange}
        {...props}
      />
    </QueryClientProvider>,
  );
  return { ...view, onFiltersChange };
};

const choose = async (option: HTMLElement) => {
  await act(async () => {
    fireEvent.pointerDown(option);
    fireEvent.click(option);
  });
};

describe("InsightsControls", () => {
  afterEach(cleanup);
  beforeEach(() => {
    mocks.channels.mockReturnValue({
      data: [{ name: "production" }, { name: "beta" }],
    });
  });

  it("applies each filter as it changes, with no Apply step", async () => {
    const { onFiltersChange } = renderControls();
    expect(screen.queryByRole("button", { name: /Apply/ })).toBeNull();

    fireEvent.click(screen.getByRole("combobox", { name: "Platform" }));
    await choose(await screen.findByRole("option", { name: "Android" }));
    expect(onFiltersChange).toHaveBeenLastCalledWith({ platform: "android" });

    fireEvent.click(screen.getByRole("combobox", { name: /^Channel/ }));
    const search = await screen.findByRole("combobox", {
      name: "Search channels",
    });
    act(() => search.focus());
    fireEvent.input(search, {
      inputType: "insertText",
      target: { value: "bet" },
    });
    const beta = await screen.findByRole("option", { name: "beta" });
    expect(screen.queryByRole("option", { name: "production" })).toBeNull();
    await choose(beta);
    expect(onFiltersChange).toHaveBeenLastCalledWith({ channel: "beta" });

    fireEvent.click(screen.getByRole("combobox", { name: "App version" }));
    await choose(await screen.findByRole("option", { name: "2.0.0" }));
    expect(onFiltersChange).toHaveBeenLastCalledWith({ appVersion: "2.0.0" });
  });

  it("marks only the narrowed filters, clears each one, and resets them all", () => {
    const { onFiltersChange, rerender } = renderControls();
    // The defaults are plain, with nothing to clear or reset.
    expect(
      screen
        .getByRole("combobox", { name: "Platform" })
        .getAttribute("data-active"),
    ).toBe("false");
    expect(screen.queryByRole("button", { name: /^Clear/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reset filters" })).toBeNull();

    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <InsightsControls
          filters={{
            channel: "beta",
            platform: "ios",
            appVersion: "2.0.0",
          }}
          appVersions={["1.0.0", "2.0.0"]}
          releases={[]}
          onFiltersChange={onFiltersChange}
        />
      </QueryClientProvider>,
    );
    expect(
      screen
        .getByRole("combobox", { name: "Platform" })
        .getAttribute("data-active"),
    ).toBe("true");
    expect(
      screen
        .getByRole("combobox", { name: /^Channel/ })
        .getAttribute("data-active"),
    ).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Clear platform" }));
    expect(onFiltersChange).toHaveBeenLastCalledWith({ platform: "all" });
    fireEvent.click(screen.getByRole("button", { name: "Clear app version" }));
    expect(onFiltersChange).toHaveBeenLastCalledWith({
      appVersion: undefined,
    });
    fireEvent.click(screen.getByRole("button", { name: "Reset filters" }));
    expect(onFiltersChange).toHaveBeenLastCalledWith({
      channel: "production",
      platform: "all",
      appVersion: undefined,
      releaseId: undefined,
    });
  });

  it("focuses a release picked from the channel's live bundles first", async () => {
    const { onFiltersChange } = renderControls({
      releases: [
        release("01a16ed8-85df-749f-8f9e-0e22532a5d87", {
          enabled: false,
          live: false,
          targetAppVersion: "1.6.2",
        }),
        release("01a13d86-86f7-7830-952d-21238207019f"),
      ],
    });
    fireEvent.click(screen.getByRole("combobox", { name: /^Release/ }));
    const search = await screen.findByRole("combobox", {
      name: "Search releases",
    });
    expect(
      within(screen.getByRole("listbox"))
        .getAllByRole("group")
        .map((group) => group.textContent),
    ).toEqual([
      expect.stringMatching(/^Live.*01a13d86/),
      expect.stringMatching(/^Not live.*01a16ed8.*Disabled/),
    ]);
    act(() => search.focus());
    fireEvent.input(search, {
      inputType: "insertText",
      target: { value: "1.6.x" },
    });
    await choose(await screen.findByRole("option", { name: /01a13d86/ }));
    expect(onFiltersChange).toHaveBeenLastCalledWith({
      releaseId: "01a13d86-86f7-7830-952d-21238207019f",
    });
  });

  it("lets the user retry an unavailable channel list", async () => {
    const refetch = vi.fn();
    mocks.channels.mockReturnValue({ isError: true, refetch });
    renderControls();
    fireEvent.click(screen.getByRole("combobox", { name: /^Channel/ }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Retry channels" }),
    );
    expect(refetch).toHaveBeenCalledOnce();
  });
});
