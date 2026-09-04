import { cleanup, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { InsightsOverview } from "./InsightsOverview";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, ...props }: { children: ReactNode; to: string }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

describe("InsightsOverview", () => {
  afterEach(cleanup);

  it("shows one actionable reporting metric without analytic detail", () => {
    render(
      <InsightsOverview
        active={{
          activeInstallations: 12_345,
          asOfMs: Date.UTC(2026, 6, 18, 1, 2, 3),
          window: "30d",
        }}
        status="success"
      />,
    );

    const metric = screen.getByRole("region", {
      name: "Reporting installations",
    });
    expect(within(metric).getByText("12,345")).toBeDefined();
    expect(metric.textContent).toContain("the last 30 days");
    expect(within(metric).getByText("Measured at")).toBeDefined();
    expect(
      screen.getByRole("link", { name: /view events/i }).getAttribute("href"),
    ).toBe("/installations");
    expect(screen.queryByText(/bundle|applied|recovered/i)).toBeNull();
  });

  it("renders loading and useful error states", () => {
    const view = render(<InsightsOverview status="loading" />);
    expect(
      screen.getByLabelText("Loading reporting installations"),
    ).toBeDefined();

    view.rerender(
      <InsightsOverview status="error" error={new Error("Database offline")} />,
    );
    expect(screen.getByRole("alert").textContent).toContain(
      "Reporting installations unavailable",
    );
  });
});
