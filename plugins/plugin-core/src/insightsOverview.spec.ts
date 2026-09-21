import { describe, expect, it } from "vitest";

import { insightsOverviewDeltas } from "./insightsOverview";
import type { BundleEventRow } from "./types";

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
      username: null,
      cohort: "default",
      update_strategy: null,
      fingerprint_hash: null,
      sdk_version: null,
    },
    received_at_ms: 3_600_001,
  }) as BundleEventRow;

describe("Insights overview event contributions", () => {
  it("attributes recovery failure to the source and readiness to the destination", () => {
    const rows = insightsOverviewDeltas(event("RECOVERED"));
    const lifetime = rows.filter(
      ({ identity }) =>
        identity.scopeKind === "release" && identity.periodKind === "lifetime",
    );
    expect(lifetime).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          identity: expect.objectContaining({ releaseId: "source-release" }),
          failedLaunches: 1,
          launches: 0,
        }),
        expect.objectContaining({
          identity: expect.objectContaining({
            releaseId: "destination-release",
          }),
          failedLaunches: 0,
          launches: 1,
        }),
      ]),
    );
  });

  it("counts downloads without treating them as launches", () => {
    const lifetime = insightsOverviewDeltas(event("UPDATE_DOWNLOADED")).find(
      ({ identity }) =>
        identity.scopeKind === "release" && identity.periodKind === "lifetime",
    );
    expect(lifetime).toMatchObject({
      downloads: 1,
      launches: 0,
      failedLaunches: 0,
    });
  });
});
