import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
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
          platform: "ios",
          channel: "production",
          sinceMs: 0,
          beforeReceivedAtMs: 100,
          reportingInstallations: {
            count: 12_345,
            measuredAtMs: Date.UTC(2026, 6, 18, 1, 2, 3),
          },
          window: "30d",
        }}
        onOutcomeSelect={vi.fn()}
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

  it("keeps installation counts independent and opens the exact recovery report range", () => {
    const onOutcomeSelect = vi.fn();
    const measure = (count: number) => ({ count, measuredAtMs: 1_000 });
    render(
      <InsightsOverview
        status="success"
        onOutcomeSelect={onOutcomeSelect}
        active={{
          platform: "ios",
          channel: "beta",
          window: "7d",
          sinceMs: 100,
          beforeReceivedAtMs: 1_000,
          reportingInstallations: measure(1),
          bundle: {
            bundleId: "bundle-B",
            reportingInstallations: measure(2),
            appliedReports: measure(5),
            recoveredReports: measure(3),
            adoptedReports: measure(0),
          },
        }}
      />,
    );
    expect(screen.getByText("Selected bundle installations")).toBeDefined();
    expect(screen.getByText("2")).toBeDefined();
    expect(screen.queryByText(/%/)).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "View recovered reports" }),
    );
    expect(onOutcomeSelect).toHaveBeenCalledWith({
      bundle: {
        platform: "ios",
        channel: "beta",
        bundleId: "bundle-B",
        outcome: "recovered",
      },
      sinceMs: 100,
      beforeReceivedAtMs: 1_000,
    });
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
