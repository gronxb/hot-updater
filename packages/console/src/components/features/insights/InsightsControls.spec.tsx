import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { InsightsControls } from "./InsightsControls";

describe("InsightsControls", () => {
  afterEach(cleanup);

  it("changes the overview reporting period", () => {
    const onWindowChange = vi.fn();
    render(<InsightsControls window="30d" onWindowChange={onWindowChange} />);

    expect(
      screen
        .getByRole("button", { name: "30 days" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "7 days" }));
    expect(onWindowChange).toHaveBeenCalledWith("7d");
  });
});
