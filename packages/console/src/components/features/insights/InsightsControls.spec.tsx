import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { InsightsControls } from "./InsightsControls";

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    className,
  }: {
    children: ReactNode;
    to: string;
    className?: string;
  }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
}));

describe("InsightsControls", () => {
  afterEach(cleanup);

  it("changes range and searches one trimmed user or install ID with Enter", () => {
    const onWindowChange = vi.fn();
    const onInstallationSearch = vi.fn();
    render(
      <InsightsControls
        window="30d"
        onInstallationSearch={onInstallationSearch}
        onWindowChange={onWindowChange}
      />,
    );

    const controls = screen.getByRole("region", {
      name: "Insights controls",
    });
    expect(controls.querySelector('[data-slot="card"]')).toBeNull();
    expect(
      screen
        .getByRole("button", { name: "24 hours" })
        .closest('[data-slot="toggle-group"]')
        ?.getAttribute("data-size"),
    ).toBe("lg");
    expect(
      screen.getByRole("button", { name: "Search" }).getAttribute("data-slot"),
    ).toBe("button");

    fireEvent.click(screen.getByRole("button", { name: "7 days" }));
    fireEvent.change(
      screen.getByRole("searchbox", { name: "User or install ID" }),
      { target: { value: "  install-1  " } },
    );
    fireEvent.submit(screen.getByRole("search", { name: "Filter insights" }));

    expect(onWindowChange).toHaveBeenCalledWith("7d");
    expect(onInstallationSearch).toHaveBeenCalledWith("install-1");
  });

  it("clears the installation search draft", () => {
    const onInstallationSearch = vi.fn();
    render(
      <InsightsControls
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
      <InsightsControls
        window="24h"
        onInstallationSearch={onInstallationSearch}
        onWindowChange={vi.fn()}
      />,
    );

    fireEvent.submit(screen.getByRole("search", { name: "Filter insights" }));

    expect(onInstallationSearch).not.toHaveBeenCalled();
  });
});
