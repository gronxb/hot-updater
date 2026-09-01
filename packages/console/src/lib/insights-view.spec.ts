import type {
  BundleEventRow,
  InsightsInstallationRow,
  InsightsPageData,
  InsightsTotal,
} from "@hot-updater/plugin-core";
import { describe, expect, it } from "vitest";

import {
  getExactInsightsTotal,
  mapInsightsPageData,
  toInsightsEventRow,
  toInsightsInstallationViewRow,
} from "./insights-view";

const event: BundleEventRow = {
  app_version: "1.2.3",
  channel: "production",
  cohort: "cohort-a",
  fingerprint_hash: null,
  from_bundle_id: "bundle-old",
  from_release_id: "release-old",
  id: "event-1",
  install_id: "install-1",
  platform: "ios",
  received_at_ms: 1_754_000_000_000,
  sdk_version: "1.0.0",
  to_bundle_id: "bundle-new",
  to_release_id: "release-new",
  type: "UPDATE_APPLIED",
  update_strategy: "appVersion",
  user_id: "user-1",
  username: "Ada",
};

describe("Insights view adapters", () => {
  it("maps provider event fields to the current console view shape", () => {
    expect(toInsightsEventRow(event)).toEqual({
      appVersion: "1.2.3",
      channel: "production",
      cohort: "cohort-a",
      fromBundleId: "bundle-old",
      id: "event-1",
      installId: "install-1",
      platform: "ios",
      receivedAtMs: 1_754_000_000_000,
      toBundleId: "bundle-new",
      type: "UPDATE_APPLIED",
      userId: "user-1",
      username: "Ada",
    });
  });

  it("maps installation projection metadata without inventing status", () => {
    const installation: InsightsInstallationRow = event;

    expect(toInsightsInstallationViewRow(installation)).toMatchObject({
      installId: "install-1",
      lastKnownBundleId: "bundle-new",
      latestStatus: "UPDATE_APPLIED",
      receivedAtMs: 1_754_000_000_000,
    });
  });

  it("preserves cursor and consistency metadata while mapping rows", () => {
    const page: InsightsPageData<BundleEventRow> = {
      consistency: {
        cutoff: { beforeReceivedAtMs: 1_754_000_000_001, kind: "event-time" },
        kind: "live",
      },
      data: [event],
      hasNext: true,
      nextCursor: "cursor-2",
      total: { state: "pending", jobId: "total-1" },
    };

    const mapped = mapInsightsPageData(page, toInsightsEventRow);

    expect(mapped.data).toEqual([toInsightsEventRow(event)]);
    expect(mapped.nextCursor).toBe("cursor-2");
    expect(mapped.consistency).toBe(page.consistency);
    expect(mapped.total).toBe(page.total);
  });

  it("shows a total only when it is exact for the current source generation", () => {
    const exact: InsightsTotal = {
      sourceGeneration: "source-2",
      state: "exact",
      value: 51_234,
    };

    expect(getExactInsightsTotal(exact, "source-2")).toBe(51_234);
    expect(getExactInsightsTotal(exact, "source-1")).toBeNull();
    expect(
      getExactInsightsTotal({ state: "pending", jobId: "total-1" }, "source-2"),
    ).toBeNull();
    expect(
      getExactInsightsTotal({ state: "unavailable" }, "source-2"),
    ).toBeNull();
  });
});
