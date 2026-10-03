import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BundleActivityReport } from "@/lib/bundle-activity";

import {
  BundleInsightsSummary,
  BundleMovementSummary,
  ReleaseFailuresSection,
} from "./ReleaseActivity";

const features = vi.hoisted(() => ({ insightsAnalytics: true }));

vi.mock("@/lib/console-features-api", () => ({
  useConsoleFeature: (feature: keyof typeof features) =>
    features[feature] ?? false,
}));
vi.mock("@/lib/bundle-activity", () => ({
  useBundleActivityQuery: () => ({ data: undefined, isFetching: false }),
}));
vi.mock("@/lib/insights-api", () => ({
  useUpdateFailuresQuery: vi.fn(() => ({
    data: { failedUpdates: 12, failedInstallations: 4, downloads: 36 },
    isPending: false,
  })),
}));

const input = {
  platform: "ios",
  channel: "production",
  releaseId: "release-1",
} as const;

describe("release Insights sections", () => {
  afterEach(() => {
    cleanup();
    features.insightsAnalytics = true;
  });

  it("shows a release's download failures and their rate in its Insights card", async () => {
    const { useUpdateFailuresQuery } = await import("@/lib/insights-api");
    render(<BundleInsightsSummary input={input} />);
    // 12 failure reports over 12 + 36 download reports.
    expect(screen.getByRole("term").textContent).toBe("Download failures");
    expect(screen.getByRole("definition").textContent).toBe("12(25.00%)");
    expect(useUpdateFailuresQuery).toHaveBeenCalledWith(input);
  });

  it("shows download failures alone where the console reads no release activity", () => {
    features.insightsAnalytics = false;
    render(<ReleaseFailuresSection input={input} />);
    expect(screen.getByText("Insights")).toBeDefined();
    expect(screen.getByRole("term").textContent).toBe("Download failures");
    expect(screen.getByRole("definition").textContent).toBe("12(25.00%)");
  });

  it("leaves them to the activity card where the console reads release activity", () => {
    const { container } = render(<ReleaseFailuresSection input={input} />);
    expect(container.textContent).toBe("");
  });

  it.each(["inline", "card"] as const)(
    "preserves activity counts, crash rate, and partial coverage in the %s layout",
    (variant) => {
      const report: BundleActivityReport = {
        downloads: 1234,
        activeDays: 98,
        failedLaunches: 2,
        measuredAtMs: 0,
        coverage: { kind: "partial", sinceMs: 0 },
      };
      render(<BundleMovementSummary report={report} variant={variant} />);

      expect(
        screen.getAllByRole("term").map((term) => term.textContent),
      ).toEqual(["Downloads", "Active days", "Known crashes"]);
      expect(
        screen.getAllByRole("definition").map((value) => value.textContent),
      ).toEqual([report.downloads.toLocaleString(), "98", "2(2.00%)"]);
      expect(screen.getByText("Partial")).toBeDefined();
    },
  );
});
