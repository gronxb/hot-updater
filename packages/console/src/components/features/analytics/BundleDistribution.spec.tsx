import type { ActiveInstallationOverview } from "@hot-updater/plugin-core";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { AnalyticsOverview } from "@/lib/analytics-overview";

import { BundleDistribution } from "./BundleDistribution";

describe("BundleDistribution", () => {
  afterEach(cleanup);

  it("shows counts and shares whose rows sum to the active total", () => {
    const active: ActiveInstallationOverview = {
      asOfMs: Date.UTC(2026, 6, 18),
      window: "7d",
      activeInstallations: 4,
      series: [],
      bundles: [
        {
          bundleId: "01972030-1aa1-7445-8b8c-121212121212",
          installations: 3,
        },
        { bundleId: "unknown", installations: 1 },
      ],
    };
    const catalog: AnalyticsOverview = {
      trackedInstallations: 4,
      mostCommonLatestReportedBundle: null,
      latestReportedBundles: [],
      configuredRollouts: [
        {
          bundleId: "01972030-1aa1-7445-8b8c-121212121212",
          configuredPercentage: 100,
          trackedInstallations: 3,
          bundle: {
            platform: "ios",
            channel: "production",
            targetAppVersion: "1.0.0",
            fingerprintHash: null,
          },
        },
      ],
    };

    render(<BundleDistribution active={active} catalog={catalog} />);

    expect(
      screen.queryByRole("img", {
        name: "Active installations by bundle chart",
      }),
    ).toBeNull();
    const table = screen.getByRole("table", {
      name: "Active installations by bundle",
    });
    expect(
      within(table).getByRole("columnheader", { name: "Activity" }),
    ).toBeDefined();
    expect(
      within(table).getByRole("columnheader", { name: "Active" }),
    ).toBeDefined();
    expect(within(table).getByText("3")).toBeDefined();
    expect(within(table).getByText("75%")).toBeDefined();
    expect(within(table).getByText("1")).toBeDefined();
    expect(within(table).getByText("25%")).toBeDefined();
    expect(within(table).getByText("Unknown bundle metadata")).toBeDefined();
    expect(
      within(table).getByRole("progressbar", {
        name: "01972030-1aa1-7445-8b8c-121212121212 activity share 75%",
      }),
    ).toBeDefined();
  });
});
