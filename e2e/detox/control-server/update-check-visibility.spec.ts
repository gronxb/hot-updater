import { describe, expect, it } from "vitest";

import { shouldProbeUpdateCheckVisibility } from "./update-check-visibility.ts";

describe("update-check visibility probing", () => {
  it("keeps local provider probes where the control server can observe quickly", () => {
    expect(
      shouldProbeUpdateCheckVisibility({
        appBaseUrl: "http://127.0.0.1:3007/hot-updater",
        disabled: false,
        rollout: undefined,
        targetCohorts: undefined,
      }),
    ).toBe(true);
  });

  it("skips remote provider probes and lets the app exercise the real update check", () => {
    expect(
      shouldProbeUpdateCheckVisibility({
        appBaseUrl: "https://d30mjvh5w5yleu.cloudfront.net/api/check-update",
        disabled: false,
        rollout: undefined,
        targetCohorts: undefined,
      }),
    ).toBe(false);
  });

  it("skips probes for rollout, cohort, and disabled bundles", () => {
    expect(
      shouldProbeUpdateCheckVisibility({
        appBaseUrl: "http://localhost:3007/hot-updater",
        disabled: true,
        rollout: undefined,
        targetCohorts: undefined,
      }),
    ).toBe(false);
    expect(
      shouldProbeUpdateCheckVisibility({
        appBaseUrl: "http://localhost:3007/hot-updater",
        disabled: false,
        rollout: 50,
        targetCohorts: undefined,
      }),
    ).toBe(false);
    expect(
      shouldProbeUpdateCheckVisibility({
        appBaseUrl: "http://localhost:3007/hot-updater",
        disabled: false,
        rollout: undefined,
        targetCohorts: ["beta"],
      }),
    ).toBe(false);
  });
});
