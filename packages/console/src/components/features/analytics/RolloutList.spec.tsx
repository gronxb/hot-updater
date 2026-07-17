import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { ConfiguredRollout } from "@/lib/analytics-overview";

import { RolloutList } from "./RolloutList";

const rollout = (
  bundleId: string,
  configuredPercentage: number,
  trackedInstallations: number,
): ConfiguredRollout => ({
  bundleId,
  configuredPercentage,
  trackedInstallations,
  bundle: {
    platform: "ios",
    channel: "production",
    targetAppVersion: "1.0.0",
    fingerprintHash: null,
  },
});

describe("RolloutList", () => {
  afterEach(cleanup);

  it("ranks partial rollouts deterministically and exposes exact progress", () => {
    render(
      <RolloutList
        rollouts={[
          rollout("default-a", 100, 50),
          rollout("partial-b", 25, 700),
          rollout("default-b", 100, 100),
          rollout("partial-a", 50, 900),
        ]}
        latestReportedBundles={[
          { bundleId: "default-a", installations: 50 },
          { bundleId: "partial-b", installations: 7 },
          { bundleId: "default-b", installations: 100 },
          { bundleId: "partial-a", installations: 7 },
        ]}
      />,
    );

    const rows = within(screen.getByRole("list")).getAllByRole("listitem");
    expect(rows.map((row) => row.querySelector("code")?.textContent)).toEqual([
      "default-b",
      "default-a",
      "partial-a",
      "partial-b",
    ]);
    expect(within(rows[2]).getByText("7 reported in range")).toBeDefined();
    expect(within(rows[2]).queryByText("900")).toBeNull();
    expect(within(rows[2]).getByText("50% configured")).toBeDefined();
    const progress = within(rows[2]).getByRole("progressbar", {
      name: "partial-a configured rollout 50%",
    });
    expect(progress.getAttribute("aria-valuenow")).toBe("50");
  });
});
