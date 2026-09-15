import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RecoveryReport } from "@/lib/insights-recovery";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) =>
    createElement("a", { href: to }, children),
}));

import { formatActivityRange, InsightsOverview } from "./InsightsOverview";

afterEach(cleanup);

const report: RecoveryReport = {
  sinceMs: 0,
  beforeReceivedAtMs: 3_600_000,
  intervalMs: 3_600_000,
  truncated: false,
  unattributedInstallations: 0,
  pendingInstallations: 0,
  downloadedInstallations: 1,
  availableReleaseIds: ["release-new", "release-old"],
  series: [],
};

describe("Insights selected release", () => {
  it("requests only the bundle chosen from the bounded metadata list", () => {
    const onReleaseChange = vi.fn();
    render(
      createElement(InsightsOverview, {
        input: { platform: "ios", channel: "production", window: "30d" },
        onReleaseChange,
        onWindowChange: vi.fn(),
        onRefresh: vi.fn(),
        query: {
          data: report,
          error: null,
          isFetching: false,
          isPending: false,
        },
      }),
    );

    fireEvent.change(screen.getByRole("combobox", { name: "Bundle" }), {
      target: { value: "release-old" },
    });

    expect(onReleaseChange).toHaveBeenCalledWith("release-old");
  });

  it("labels the actual UTC range and partial interval", () => {
    const label = formatActivityRange({
      startMs: 0,
      rangeStartMs: 3_600_000,
      endMs: 7_200_000,
      partial: true,
      active: null,
      pendingInstallations: null,
      downloadedInstallations: 1,
      recoveredInstallations: 0,
      applied: 1,
      recovered: 0,
      rate: 0,
      spike: false,
    });

    expect(label).toContain("UTC · Partial");
    expect(label).not.toContain("Invalid Date");
  });
});
