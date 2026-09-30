import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BundleInsightsSummary,
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
    expect(screen.getByText("Download failures 12 (25.00%)")).toBeDefined();
    expect(useUpdateFailuresQuery).toHaveBeenCalledWith(input);
  });

  it("shows download failures alone where the console reads no release activity", () => {
    features.insightsAnalytics = false;
    render(<ReleaseFailuresSection input={input} />);
    expect(screen.getByText("Insights")).toBeDefined();
    expect(screen.getByText("Download failures 12 (25.00%)")).toBeDefined();
  });

  it("leaves them to the activity card where the console reads release activity", () => {
    const { container } = render(<ReleaseFailuresSection input={input} />);
    expect(container.textContent).toBe("");
  });
});
