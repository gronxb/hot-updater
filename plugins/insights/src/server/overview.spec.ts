import { describe, expect, it } from "vitest";

import type { BundleEventRow } from "./eventRow";
import { insightsOverviewDeltas } from "./overview";

const event = (type: BundleEventRow["type"]): BundleEventRow =>
  ({
    id: "01993e00-0000-7000-8000-000000000001",
    type,
    install_id: "install-a",
    user_id: null,
    from_release_id: type === "UNCHANGED" ? null : "source-release",
    from_bundle_id: type === "UNCHANGED" ? null : "source-bundle",
    to_release_id: "destination-release",
    to_bundle_id: "destination-bundle",
    platform: "ios",
    app_version: "1.0.0",
    channel: "production",
    metadata: {
      cohort: "default",
      update_strategy: null,
      fingerprint_hash: null,
      sdk_version: null,
    },
    received_at_ms: 3_600_001,
  }) as BundleEventRow;

describe("Insights overview event contributions", () => {
  const releaseRows = (type: BundleEventRow["type"]) =>
    insightsOverviewDeltas(event(type)).filter(
      ({ identity }) => identity.scopeKind !== "usage",
    );

  it("counts a recovery's crash on the bundle it left, and no apply on the one it returned to", () => {
    const lifetime = releaseRows("RECOVERED").filter(
      ({ identity }) =>
        identity.scopeKind === "release" && identity.periodKind === "lifetime",
    );
    expect(lifetime).toEqual([
      expect.objectContaining({
        identity: expect.objectContaining({ releaseId: "source-release" }),
        failedLaunches: 1,
        applies: 0,
      }),
    ]);
  });

  it("counts an apply on its release's lifetime row only", () => {
    const rows = releaseRows("UPDATE_APPLIED");
    expect(
      rows.map(({ identity, applies }) => [
        identity.scopeKind,
        identity.periodKind,
        applies,
      ]),
    ).toEqual([
      ["release", "lifetime", 1],
      ["release", "hour", 0],
      ["channel", "hour", 0],
    ]);
  });

  it("counts downloads without treating them as applies", () => {
    const lifetime = releaseRows("UPDATE_DOWNLOADED").find(
      ({ identity }) =>
        identity.scopeKind === "release" && identity.periodKind === "lifetime",
    );
    expect(lifetime).toMatchObject({
      downloads: 1,
      applies: 0,
      failedLaunches: 0,
    });
  });

  it("changes no release or channel counter for a launch report", () => {
    expect(releaseRows("UNCHANGED")).toEqual([]);
    // Its installation still counts as active in usage.
    expect(
      insightsOverviewDeltas(event("UNCHANGED")).every(
        ({ identity, activityIdentity }) =>
          identity.scopeKind === "usage" && activityIdentity === "install-a",
      ),
    ).toBe(true);
  });
});
