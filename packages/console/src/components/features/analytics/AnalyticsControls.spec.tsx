import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AnalyticsControls } from "./AnalyticsControls";

describe("AnalyticsControls", () => {
  afterEach(cleanup);

  it("changes range and applies one trimmed exact User ID alias with Enter", () => {
    const onWindowChange = vi.fn();
    const onUserIdChange = vi.fn();
    render(
      <AnalyticsControls
        userId={undefined}
        window="30d"
        onUserIdChange={onUserIdChange}
        onWindowChange={onWindowChange}
      />,
    );

    expect(
      screen.getByRole("heading", { level: 2, name: "Report scope" }),
    ).toBeDefined();

    fireEvent.click(screen.getByRole("radio", { name: "7 days" }));
    fireEvent.change(screen.getByRole("textbox", { name: "User ID alias" }), {
      target: { value: "  Alias/B  " },
    });
    fireEvent.submit(screen.getByRole("search", { name: "Filter analytics" }));

    expect(onWindowChange).toHaveBeenCalledWith("7d");
    expect(onUserIdChange).toHaveBeenCalledWith("Alias/B");
  });

  it("clears both the draft and applied alias", () => {
    const onUserIdChange = vi.fn();
    render(
      <AnalyticsControls
        userId="Alias/B"
        window="24h"
        onUserIdChange={onUserIdChange}
        onWindowChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Clear User ID" }));

    expect(onUserIdChange).toHaveBeenCalledWith(undefined);
    expect(
      (
        screen.getByRole("textbox", {
          name: "User ID alias",
        }) as HTMLInputElement
      ).value,
    ).toBe("");
  });
});
