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
  pendingInstallations: 0,
  downloadedInstallations: 0,
  series: ["new-id", "old-id"].map((releaseId, index) => ({
    releaseId,
    firstAppliedAtMs: 0,
    activeInstallations: index === 0 ? 90 : 10,
    pendingInstallations: 0,
    downloadedInstallations: 0,
    recoveredInstallations: index === 0 ? 3 : 0,
    points: [10, 50, 90].map((active, i) => ({
      startMs: i * DAY,
      active: index === 0 ? active : 100 - active,
      pendingInstallations: 0,
      downloadedInstallations: 0,
      recoveredInstallations: index === 0 && i === 2 ? 3 : 0,
      applied: 7,
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
    fireEvent.click(screen.getByRole("tab", { name: "Rollback" }));
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

  it("switches between distinct downloaded installations and the current pending snapshot", () => {
    const downloads: RecoveryReport = {
      ...report,
      downloadedInstallations: 5,
      pendingInstallations: 2,
      series: report.series.map((series) => ({
        ...series,
        downloadedInstallations: 4,
        pendingInstallations: 1,
        points: series.points.map((point) => ({
          ...point,
          downloadedInstallations: 4,
          pendingInstallations: 1,
        })),
      })),
    };
    render(<ActivityChart report={downloads} />);
    fireEvent.click(screen.getByRole("tab", { name: "Downloaded" }));
    expect(
      screen.getByLabelText("Downloaded trend for all reported bundle IDs"),
    ).toBeDefined();
    // Five distinct installations across two releases, not eight release-installation pairs.
    expect(screen.getAllByText("5").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("tab", { name: "Pending apply" }));
    expect(
      screen.getByLabelText("Pending apply trend for all reported bundle IDs"),
    ).toBeDefined();
    expect(screen.getAllByText("2").length).toBeGreaterThan(0);
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
    const onWindowChange = vi.fn();
    let query = {
      data: undefined as RecoveryReport | undefined,
      error: null as Error | null,
      isPending: true,
      isFetching: false,
    };
    const view = render(
      <InsightsOverview
        input={input}
        onWindowChange={onWindowChange}
        query={query}
        onRefresh={refetch}
      />,
    );
    expect(screen.getByLabelText("Loading bundle activity")).toBeDefined();
    expect(
      screen
        .getByRole("tab", { name: "30 days" })
        .getAttribute("aria-selected"),
    ).toBe("true");
    fireEvent.click(screen.getByRole("tab", { name: "7 days" }));
    expect(onWindowChange).toHaveBeenCalledWith("7d");
    expect(
      within(screen.getByRole("region", { name: "Bundle activity" }))
        .getByRole("link", { name: "All events" })
        .getAttribute("href"),
    ).toBe("/installations");
    query = { ...query, isPending: false, error: new Error("Offline") };
    view.rerender(
      <InsightsOverview
        input={input}
        onWindowChange={onWindowChange}
        query={query}
        onRefresh={refetch}
      />,
    );
    expect(screen.getByText("Bundle activity unavailable")).toBeDefined();
    fireEvent.click(
      screen.getByRole("button", { name: "Refresh bundle activity" }),
    );
    expect(refetch).toHaveBeenCalledOnce();
    query = {
      ...query,
      error: null,
      data: {
        ...report,
        series: [],
        truncated: true,
        unattributedInstallations: 4,
      },
    };
    view.rerender(
      <InsightsOverview
        input={input}
        onWindowChange={onWindowChange}
        query={query}
        onRefresh={refetch}
      />,
    );
    expect(screen.getByText(/No bundle reports in this period/)).toBeDefined();
    expect(screen.getByText(/Partial history/)).toBeDefined();
    expect(
      screen.getByText(
        /4 reporting installations have no observed running release ID/,
      ),
    ).toBeDefined();
  });
});
