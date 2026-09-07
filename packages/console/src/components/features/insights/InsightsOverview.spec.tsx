import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { cloneElement, type ReactElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RecoveryReport } from "@/lib/insights-recovery";

import { InsightsOverview, ActivityChart } from "./InsightsOverview";

const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@tanstack/react-query", () => ({ useQuery: mocks.query }));
vi.mock("@/lib/insights-recovery-rpc", () => ({
  getRecoveryReportRpc: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    search,
    to,
  }: {
    children: ReactNode;
    search?: { releaseId: string };
    to: string;
  }) => (
    <a href={search?.releaseId ? `/?releaseId=${search.releaseId}` : to}>
      {children}
    </a>
  ),
}));
vi.mock("recharts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("recharts")>()),
  ResponsiveContainer: ({ children }: { children: ReactElement }) =>
    cloneElement(children, { width: 600, height: 224 } as object),
}));
const DAY = 86_400_000;
const report: RecoveryReport = {
  sinceMs: 0,
  beforeReceivedAtMs: 3 * DAY,
  intervalMs: DAY,
  truncated: false,
  unattributedInstallations: 0,
  series: ["new-id", "old-id"].map((releaseId, index) => ({
    releaseId,
    firstAdoptedAtMs: 0,
    activeInstallations: index === 0 ? 90 : 10,
    recoveredInstallations: index === 0 ? 3 : 0,
    points: [10, 50, 90].map((active, i) => ({
      startMs: i * DAY,
      active: index === 0 ? active : 100 - active,
      recoveredInstallations: index === 0 && i === 2 ? 3 : 0,
      adopted: 7,
      recovered: index === 0 && i === 2 ? 3 : 0,
      rate: index === 0 && i === 2 ? 30 : 0,
      spike: index === 0 && i === 2,
    })),
  })),
};
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("bundle trends", () => {
  it("shows every ID together and preserves all lines when highlighting a bundle or filtering rollbacks", () => {
    const { container } = render(<ActivityChart report={report} />);
    expect(container.querySelectorAll(".recharts-line-curve")).toHaveLength(2);
    expect(
      screen.getByLabelText("Active trend for all reported bundle IDs"),
    ).toBeDefined();
    expect(screen.queryByRole("combobox")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Highlight bundle new-id" }),
    );
    expect(container.querySelectorAll(".recharts-line-curve")).toHaveLength(2);
    expect(
      screen.getByRole("link", { name: "Review bundle" }).getAttribute("href"),
    ).toBe("/?releaseId=new-id");
    fireEvent.click(screen.getByRole("button", { name: "Rollback" }));
    expect(
      screen.getByLabelText("Rollback trend for all reported bundle IDs"),
    ).toBeDefined();
    expect(container.querySelectorAll(".recharts-line-curve")).toHaveLength(2);
    expect(screen.getByText(/Rollback spike on/)).toBeDefined();
    expect(
      screen
        .getByRole("button", { name: "Highlight bundle new-id" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    const rows = within(
      screen.getByRole("table", { hidden: true }),
    ).getAllByRole("row", { hidden: true });
    expect(rows.at(-1)?.textContent).toContain("30");
    fireEvent.click(
      screen.getByRole("button", { name: "Highlight bundle old-id" }),
    );
    expect(screen.queryByText(/Rollback spike on/)).toBeNull();
  });

  it("keeps IDs beyond a top-five list and exposes exact values without requiring chart interaction", () => {
    const many = {
      ...report,
      series: Array.from({ length: 8 }, (_, i) => ({
        ...report.series[0],
        releaseId: `bundle-${i}`,
      })),
    };
    const { container } = render(<ActivityChart report={many} />);
    expect(container.querySelectorAll(".recharts-line-curve")).toHaveLength(8);
    expect(
      screen.getByRole("button", { name: "Highlight bundle bundle-7" }),
    ).toBeDefined();
    expect(screen.getByText("View chart data")).toBeDefined();
    expect(screen.getAllByRole("columnheader", { hidden: true })).toHaveLength(
      9,
    );
  });

  it("handles loading, errors, empty history and partial results with a refresh action", () => {
    const input = {
      platform: "ios",
      channel: "production",
      window: "30d",
    } as const;
    const refetch = vi.fn();
    mocks.query.mockReturnValue({ isPending: true, refetch });
    const view = render(<InsightsOverview input={input} />);
    expect(screen.getByLabelText("Loading bundle activity")).toBeDefined();
    expect(
      within(screen.getByRole("region", { name: "Bundle activity" }))
        .getByRole("link", { name: "All events" })
        .getAttribute("href"),
    ).toBe("/installations");
    mocks.query.mockReturnValue({ error: new Error("Offline"), refetch });
    view.rerender(<InsightsOverview input={input} />);
    expect(screen.getByText("Bundle activity unavailable")).toBeDefined();
    fireEvent.click(
      screen.getByRole("button", { name: "Refresh bundle activity" }),
    );
    expect(refetch).toHaveBeenCalledOnce();
    mocks.query.mockReturnValue({
      data: {
        ...report,
        series: [],
        truncated: true,
        unattributedInstallations: 4,
      },
      refetch,
    });
    view.rerender(<InsightsOverview input={input} />);
    expect(screen.getByText(/No bundle reports in this period/)).toBeDefined();
    expect(screen.getByText(/Partial history/)).toBeDefined();
    expect(
      screen.getByText(/4 reporting installations have no observed bundle ID/),
    ).toBeDefined();
  });
});
