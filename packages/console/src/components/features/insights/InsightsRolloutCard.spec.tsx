import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { cloneElement, type ReactElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RecoveryReport } from "@/lib/insights-recovery";

import { InsightsRolloutCard, RolloutChart } from "./InsightsRolloutCard";

const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@tanstack/react-query", () => ({ useQuery: mocks.query }));
vi.mock("@/lib/insights-recovery-rpc", () => ({
  getRecoveryReportRpc: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    search,
  }: {
    children: ReactNode;
    search: { releaseId: string };
  }) => <a href={`/?releaseId=${search.releaseId}`}>{children}</a>,
}));
vi.mock("recharts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("recharts")>()),
  ResponsiveContainer: ({ children }: { children: ReactElement }) =>
    cloneElement(children, { width: 600, height: 224 } as object),
}));

const HOUR = 3_600_000;
const report: RecoveryReport = {
  sinceMs: 0,
  beforeReceivedAtMs: 4 * HOUR,
  intervalMs: HOUR,
  truncated: false,
  series: [
    {
      releaseId: "promoted-id",
      firstAdoptedAtMs: 0,
      points: [
        {
          startMs: 0,
          adopted: 100,
          adoptionShare: 100,
          recovered: 0,
          rate: 0,
          spike: false,
        },
        {
          startMs: HOUR,
          adopted: 7,
          adoptionShare: 100,
          recovered: 3,
          rate: 30,
          spike: true,
        },
        {
          startMs: 2 * HOUR,
          adopted: 0,
          adoptionShare: null,
          recovered: 0,
          rate: null,
          spike: false,
        },
        {
          startMs: 3 * HOUR,
          adopted: 10,
          adoptionShare: 100,
          recovered: 0,
          rate: 0,
          spike: false,
        },
      ],
    },
  ],
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("recovery trend", () => {
  it("shows crossing adoption lines and preserves the selected ID and interval when inspecting recovery", () => {
    const crossing = {
      ...report,
      beforeReceivedAtMs: 3 * HOUR,
      series: ["new-id", "old-id"].map((releaseId, index) => ({
        releaseId,
        firstAdoptedAtMs: 0,
        points: [10, 50, 90].map((share, i) => ({
          startMs: i * HOUR,
          adopted: index === 0 ? share : 100 - share,
          adoptionShare: index === 0 ? share : 100 - share,
          recovered: 0,
          rate: 0,
          spike: false,
        })),
      })),
    };
    const { container } = render(<RolloutChart report={crossing} />);
    expect(container.querySelectorAll(".recharts-line-curve")).toHaveLength(2);
    expect(
      screen.getByText("New adoption share in selected interval"),
    ).toBeDefined();
    expect(screen.getByText("90.0")).toBeDefined();
    fireEvent.click(
      screen.getByRole("button", {
        name: /Inspect ID old-id, .*: 50.0% new adoption/,
      }),
    );
    expect(screen.getByText("50.0")).toBeDefined();
    expect(
      screen
        .getByRole("link", { name: "Review deployment" })
        .getAttribute("href"),
    ).toBe("/?releaseId=old-id");
    fireEvent.click(screen.getByRole("button", { name: "Recovery rate" }));
    expect(screen.getByText("0.0")).toBeDefined();
    expect(
      screen
        .getByRole("link", { name: "Review deployment" })
        .getAttribute("href"),
    ).toBe("/?releaseId=old-id");
    expect(
      screen
        .getByRole("button", { name: "Next interval" })
        .hasAttribute("disabled"),
    ).toBe(false);
  });
  it("shows a real time series, selects the spike and links its public ID to delivery settings", () => {
    const { container } = render(<RolloutChart report={report} />);
    expect(container.querySelector(".recharts-line-curve")).not.toBeNull();
    expect(screen.getByText("First adoption")).toBeDefined();
    expect(screen.getByText("30.0")).toBeDefined();
    expect(
      screen.getByText("3 recovered / 10 adoption + recovery reports"),
    ).toBeDefined();
    expect(
      screen.getByText("Consider rolling back this deployment"),
    ).toBeDefined();
    expect(
      screen
        .getByRole("link", { name: "Review deployment" })
        .getAttribute("href"),
    ).toBe("/?releaseId=promoted-id");
  });

  it("lets keyboard users inspect other intervals without treating missing reports as zero", () => {
    render(<RolloutChart report={report} />);
    fireEvent.click(screen.getByRole("button", { name: "Next interval" }));
    expect(screen.getByText("—")).toBeDefined();
    expect(
      screen.queryByText("Consider rolling back this deployment"),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Next interval" }));
    expect(screen.getByText("0.0")).toBeDefined();
    expect(
      screen
        .getByRole("button", { name: "Next interval" })
        .hasAttribute("disabled"),
    ).toBe(true);
  });

  it("selects a chart point directly by pointer or keyboard", () => {
    render(<RolloutChart report={report} />);
    const zeroPoints = screen.getAllByRole("button", {
      name: /Inspect .*: 0.0% recovered/,
    });
    fireEvent.click(zeroPoints[0]);
    expect(
      screen
        .getByRole("button", { name: "Previous interval" })
        .hasAttribute("disabled"),
    ).toBe(true);
    fireEvent.keyDown(
      screen.getByRole("button", { name: /Inspect .*: 30.0% recovered/ }),
      { key: "Enter" },
    );
    expect(
      screen.getByText("Consider rolling back this deployment"),
    ).toBeDefined();
  });

  it("keeps the same graph and signal in the deployment sheet without a self-link", () => {
    render(<RolloutChart report={report} inSheet />);
    expect(screen.getByText("promoted-id")).toBeDefined();
    expect(
      screen.getByText("Consider rolling back this deployment"),
    ).toBeDefined();
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("handles loading, failure, empty and incomplete history with a retry action", () => {
    const input = {
      platform: "ios",
      channel: "production",
      window: "24h",
    } as const;
    const refetch = vi.fn();
    mocks.query.mockReturnValue({ isPending: true });
    const view = render(<InsightsRolloutCard input={input} />);
    expect(screen.getByLabelText("Loading rollout activity")).toBeDefined();
    mocks.query.mockReturnValue({ error: new Error("Offline"), refetch });
    view.rerender(<InsightsRolloutCard input={input} />);
    expect(screen.getByText("Rollout activity unavailable")).toBeDefined();
    fireEvent.click(
      screen.getByRole("button", { name: "Refresh rollout activity" }),
    );
    expect(refetch).toHaveBeenCalledOnce();
    mocks.query.mockReturnValue({
      data: { ...report, series: [], truncated: true },
      refetch,
    });
    view.rerender(<InsightsRolloutCard input={input} />);
    expect(screen.getByText("No rollout activity yet")).toBeDefined();
    expect(screen.getByText("Partial history")).toBeDefined();
  });
});
