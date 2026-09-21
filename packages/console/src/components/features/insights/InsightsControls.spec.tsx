import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { InsightsControls } from "./InsightsControls";

const mocks = vi.hoisted(() => ({ channels: vi.fn() }));
vi.mock("@/lib/api", () => ({ useChannelsQuery: mocks.channels }));

describe("InsightsControls", () => {
  afterEach(cleanup);
  beforeEach(() => {
    mocks.channels.mockReturnValue({
      data: [{ name: "production" }, { name: "beta" }],
    });
  });

  it("submits one explicit filter set without querying on each input change", async () => {
    const onFiltersChange = vi.fn();
    render(
      <InsightsControls
        appVersions={["1.0.0", "2.0.0"]}
        scope={{ platform: "ios", channel: "production" }}
        releaseScope={{ platform: "ios", channel: "production" }}
        onFiltersChange={onFiltersChange}
      />,
    );
    fireEvent.click(screen.getByRole("combobox", { name: "Usage platform" }));
    const android = await screen.findByRole("option", { name: "Android" });
    await act(async () => {
      fireEvent.pointerDown(android);
      fireEvent.click(android);
    });
    act(() => screen.getByLabelText("Channel").focus());
    fireEvent.input(screen.getByLabelText("Channel"), {
      inputType: "insertText",
      target: { value: "bet" },
    });
    const beta = await screen.findByRole("option", { name: "beta" });
    expect(screen.queryByRole("option", { name: "production" })).toBeNull();
    await act(async () => {
      fireEvent.pointerDown(beta);
      fireEvent.click(beta);
    });
    fireEvent.click(screen.getByRole("combobox", { name: "Health platform" }));
    const releaseAndroid = await screen.findByRole("option", {
      name: "Android",
    });
    await act(async () => {
      fireEvent.pointerDown(releaseAndroid);
      fireEvent.click(releaseAndroid);
    });
    fireEvent.change(screen.getByLabelText("Release ID (optional)"), {
      target: { value: " release-a " },
    });
    expect(onFiltersChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Apply filters" }));
    expect(onFiltersChange).toHaveBeenCalledWith({
      scope: { platform: "android", channel: "beta" },
      releaseScope: {
        platform: "android",
        channel: "beta",
        releaseId: "release-a",
      },
    });
    expect(
      screen.getAllByRole("form", { name: "Insights filters" }),
    ).toHaveLength(1);
  });

  it("lets the user retry an unavailable channel list", async () => {
    const refetch = vi.fn();
    mocks.channels.mockReturnValue({ isError: true, refetch });
    render(
      <InsightsControls
        appVersions={["1.0.0", "2.0.0"]}
        scope={{ platform: "ios", channel: "production" }}
        releaseScope={{ platform: "ios", channel: "production" }}
        onFiltersChange={vi.fn()}
      />,
    );
    act(() => screen.getByLabelText("Channel").focus());
    fireEvent.input(screen.getByLabelText("Channel"), {
      inputType: "insertText",
      target: { value: "beta" },
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "Retry channels" }),
    );
    expect(refetch).toHaveBeenCalledOnce();
  });
});
