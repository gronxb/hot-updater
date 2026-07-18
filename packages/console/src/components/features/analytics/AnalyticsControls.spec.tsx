import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AnalyticsControls } from "./AnalyticsControls";

describe("AnalyticsControls", () => {
  afterEach(cleanup);

  it("changes range and searches one trimmed user or install ID with Enter", () => {
    const onWindowChange = vi.fn();
    const onInstallationSearch = vi.fn();
    render(
      <AnalyticsControls
        window="30d"
        onInstallationSearch={onInstallationSearch}
        onWindowChange={onWindowChange}
      />,
    );

    const controls = screen.getByRole("region", {
      name: "Analytics controls",
    });
    expect(controls.querySelector('[data-slot="card"]')).toBeNull();
    expect(
      screen
        .getByRole("radio", { name: "24 hours" })
        .closest('[data-slot="toggle-group"]')
        ?.getAttribute("data-size"),
    ).toBe("lg");

    fireEvent.click(screen.getByRole("radio", { name: "7 days" }));
    fireEvent.change(
      screen.getByRole("searchbox", { name: "User or install ID" }),
      { target: { value: "  install-1  " } },
    );
    fireEvent.submit(screen.getByRole("search", { name: "Filter analytics" }));

    expect(onWindowChange).toHaveBeenCalledWith("7d");
    expect(onInstallationSearch).toHaveBeenCalledWith("install-1");
  });

  it("clears the installation search draft", () => {
    const onInstallationSearch = vi.fn();
    render(
      <AnalyticsControls
        window="24h"
        onInstallationSearch={onInstallationSearch}
        onWindowChange={vi.fn()}
      />,
    );

    const input = screen.getByRole("searchbox", {
      name: "User or install ID",
    });
    fireEvent.change(input, { target: { value: "user-1" } });
    fireEvent.click(
      screen.getByRole("button", { name: "Clear installation search" }),
    );

    expect(onInstallationSearch).not.toHaveBeenCalled();
    expect((input as HTMLInputElement).value).toBe("");
  });

  it("does not search an empty identity", () => {
    const onInstallationSearch = vi.fn();
    render(
      <AnalyticsControls
        window="24h"
        onInstallationSearch={onInstallationSearch}
        onWindowChange={vi.fn()}
      />,
    );

    fireEvent.submit(screen.getByRole("search", { name: "Filter analytics" }));

    expect(onInstallationSearch).not.toHaveBeenCalled();
  });
});
