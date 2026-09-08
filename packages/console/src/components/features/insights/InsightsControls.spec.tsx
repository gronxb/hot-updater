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

  it("submits an explicit scope without querying on each input change", async () => {
    const onScopeChange = vi.fn();
    render(
      <InsightsControls
        scope={{ platform: "ios", channel: "production" }}
        onScopeChange={onScopeChange}
      />,
    );
    fireEvent.click(screen.getByRole("combobox", { name: "Platform" }));
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
    expect(onScopeChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Apply filters" }));
    expect(onScopeChange).toHaveBeenCalledWith({
      platform: "android",
      channel: "beta",
    });
  });

  it("lets the user retry an unavailable channel list", async () => {
    const refetch = vi.fn();
    mocks.channels.mockReturnValue({ isError: true, refetch });
    render(
      <InsightsControls
        scope={{ platform: "ios", channel: "production" }}
        onScopeChange={vi.fn()}
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
