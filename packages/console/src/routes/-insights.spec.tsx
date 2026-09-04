import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  controls: vi.fn(),
  overview: vi.fn(),
  reporting: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({ options }),
  Link: ({ children, to }: { children: ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));

vi.mock("@/components/features/insights/InsightsControls", () => ({
  InsightsControls: (props: {
    onWindowChange: (window: "24h" | "7d" | "30d") => void;
    window: "24h" | "7d" | "30d";
  }) => {
    mocks.controls(props);
    return (
      <button onClick={() => props.onWindowChange("7d")} type="button">
        Select 7 days
      </button>
    );
  },
}));

vi.mock("@/components/features/insights/InsightsOverview", () => ({
  InsightsOverview: (props: unknown) => {
    mocks.overview(props);
    return <div>Reporting installations</div>;
  },
}));

vi.mock("@/components/features/insights/InsightsPageHeader", () => ({
  InsightsPageHeader: () => <a href="/installations">Events</a>,
}));

vi.mock("@/lib/insights-api", () => ({
  useReportingInstallationsQuery: mocks.reporting,
}));

import { Route } from "./insights";

const InsightsPage = Route.options.component;
if (!InsightsPage) throw new Error("Insights route component is required");

const active = {
  activeInstallations: 42,
  asOfMs: Date.UTC(2026, 6, 18),
  window: "30d" as const,
};

describe("InsightsPage", () => {
  beforeEach(() => {
    mocks.reporting.mockReturnValue({
      data: active,
      error: null,
      isLoading: false,
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("loads only the reporting-installation headline for the selected window", () => {
    render(<InsightsPage />);

    expect(mocks.reporting).toHaveBeenCalledWith("30d");
    expect(mocks.overview).toHaveBeenLastCalledWith({
      active,
      status: "success",
    });
    expect(
      screen.getByRole("link", { name: "Events" }).getAttribute("href"),
    ).toBe("/installations");

    fireEvent.click(screen.getByRole("button", { name: "Select 7 days" }));

    expect(mocks.reporting).toHaveBeenLastCalledWith("7d");
    expect(mocks.controls).toHaveBeenLastCalledWith(
      expect.objectContaining({ window: "7d" }),
    );
  });

  it("keeps loading and failures inside the single metric surface", () => {
    mocks.reporting.mockReturnValueOnce({
      data: undefined,
      error: null,
      isLoading: true,
    });
    const view = render(<InsightsPage />);
    expect(mocks.overview).toHaveBeenLastCalledWith({ status: "loading" });

    const error = new Error("Database offline");
    mocks.reporting.mockReturnValueOnce({
      data: undefined,
      error,
      isLoading: false,
    });
    view.rerender(<InsightsPage />);
    expect(mocks.overview).toHaveBeenLastCalledWith({ error, status: "error" });
  });
});
