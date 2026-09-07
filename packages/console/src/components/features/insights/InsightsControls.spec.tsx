import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { InsightsControls } from "./InsightsControls";

describe("InsightsControls", () => {
  afterEach(cleanup);

  it("changes the overview reporting period", () => {
    const onWindowChange = vi.fn();
    render(
      <InsightsControls
        scope={{ platform: "ios", channel: "production" }}
        onScopeChange={vi.fn()}
        window="30d"
        onWindowChange={onWindowChange}
      />,
    );

    expect(
      screen
        .getByRole("button", { name: "30 days" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "7 days" }));
    expect(onWindowChange).toHaveBeenCalledWith("7d");
  });
  it("submits an explicit scope without querying on each input change", () => {
    const onScopeChange = vi.fn();
    render(
      <InsightsControls
        scope={{ platform: "ios", channel: "production" }}
        onScopeChange={onScopeChange}
        window="30d"
        onWindowChange={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Android" }));
    fireEvent.change(screen.getByLabelText("Channel"), {
      target: { value: "beta" },
    });
    fireEvent.change(screen.getByLabelText("Bundle ID (optional)"), {
      target: { value: "bundle-B" },
    });
    expect(onScopeChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Apply filters" }));
    expect(onScopeChange).toHaveBeenCalledWith({
      platform: "android",
      channel: "beta",
      bundleId: "bundle-B",
    });
  });
});
