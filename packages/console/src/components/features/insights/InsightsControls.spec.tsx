import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { InsightsControls } from "./InsightsControls";

describe("InsightsControls", () => {
  afterEach(cleanup);

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
    fireEvent.pointerDown(android);
    fireEvent.click(android);
    fireEvent.change(screen.getByLabelText("Channel"), {
      target: { value: "beta" },
    });
    expect(onScopeChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Apply filters" }));
    expect(onScopeChange).toHaveBeenCalledWith({
      platform: "android",
      channel: "beta",
    });
  });
});
