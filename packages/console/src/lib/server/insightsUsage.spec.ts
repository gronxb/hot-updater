// @vitest-environment node
import type { BundleEventRow, InsightsModel } from "@hot-updater/plugin-core";
import { describe, expect, it, vi } from "vitest";

import { getRecoveryReport } from "./insightsRecovery";
import { getAppUsageReport } from "./insightsUsage";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const now = 40 * DAY + HOUR / 2;
const input = {
  platform: "all",
  channel: "production",
  window: "24h",
} as const;
let sequence = 0;
const event = (
  installId: string,
  receivedAtMs: number,
  overrides: Partial<BundleEventRow> = {},
): BundleEventRow =>
  ({
    id: String(++sequence).padStart(10, "0"),
    install_id: installId,
    type: "UNCHANGED",
    received_at_ms: receivedAtMs,
    from_bundle_id:
      overrides.type && overrides.type !== "UNCHANGED" ? "previous-file" : null,
    to_bundle_id: "file-a",
    from_release_id: null,
    to_release_id: "bundle-a",
    platform: "ios",
    channel: "production",
    user_id: "same-person",
    username: null,
    app_version: "1.0.0",
    cohort: "default",
    fingerprint_hash: null,
    sdk_version: null,
    update_strategy:
      overrides.type && overrides.type !== "UNCHANGED" ? "appVersion" : null,
    ...overrides,
  }) as BundleEventRow;
function modelFor(events: BundleEventRow[]): InsightsModel {
  const ordered = [...events].sort(
    (a, b) => b.received_at_ms - a.received_at_ms || b.id.localeCompare(a.id),
  );
  return {
    listEvents: vi.fn(
      async ({ after, sinceMs = 0, beforeReceivedAtMs, limit }) =>
        ordered
          .filter(
            (row) =>
              row.received_at_ms >= sinceMs &&
              row.received_at_ms < beforeReceivedAtMs &&
              (!after ||
                row.received_at_ms < after.receivedAtMs ||
                (row.received_at_ms === after.receivedAtMs &&
                  row.id < after.id)),
          )
          .slice(0, limit),
    ),
  } as unknown as InsightsModel;
}

describe("app usage", () => {
  it("deduplicates all event types by installation and assigns each installation to its latest matching version", async () => {
    const model = modelFor([
      event("phone", now - 2 * HOUR),
      event("phone", now - 2 * HOUR + 1, {
        type: "UPDATE_APPLIED",
        app_version: "2.0.0",
      }),
      event("phone", now - HOUR, {
        type: "RECOVERED",
        app_version: "2.0.0",
        from_release_id: "failed-bundle",
      }),
      event("tablet", now - HOUR, { platform: "android" }),
      event("unknown-bundle", now - HOUR, { to_release_id: null }),
      event("staging", now - HOUR, { channel: "staging" }),
    ]);
    const report = await getAppUsageReport(model, input, now);
    expect(report.activeInstallations).toBe(3);
    expect(report.bundleDistribution).toEqual([
      {
        appVersion: "2.0.0",
        platform: "ios",
        releaseId: "bundle-a",
        installations: 1,
      },
      {
        appVersion: "1.0.0",
        platform: "android",
        releaseId: "bundle-a",
        installations: 1,
      },
      {
        appVersion: "1.0.0",
        platform: "ios",
        releaseId: null,
        installations: 1,
      },
    ]);
    expect(report.versions).toEqual([
      { name: "1.0.0", installations: 2 },
      { name: "2.0.0", installations: 1 },
    ]);
    expect(report.platforms).toEqual([
      { name: "ios", installations: 2 },
      { name: "android", installations: 1 },
    ]);
    expect(report.appVersions).toEqual(["2.0.0", "1.0.0"]);
    expect(report.points.filter((point) => point.installations)).toHaveLength(
      2,
    );
    expect(
      report.points
        .filter((point) => point.installations)
        .map((point) => point.installations),
    ).toEqual([1, 3]);
    expect(model.listEvents).toHaveBeenCalledOnce();
  });

  it("uses rolling boundaries and excludes reports at the snapshot boundary for every period", async () => {
    const model = modelFor([
      event("daily", now - DAY),
      event("weekly", now - 7 * DAY),
      event("monthly", now - 30 * DAY),
      event("too-old", now - 30 * DAY - 1),
      event("future", now),
    ]);
    const reports = await Promise.all(
      (["24h", "7d", "30d"] as const).map((window) =>
        getAppUsageReport(model, { ...input, window }, now),
      ),
    );
    expect(reports.map((report) => report.activeInstallations)).toEqual([
      1, 2, 3,
    ]);
    expect(reports.map((report) => report.intervalMs)).toEqual([
      HOUR,
      6 * HOUR,
      DAY,
    ]);
    expect(reports.every((report) => !report.truncated)).toBe(true);
  });

  it("applies app-version and platform filters to both usage and bundle state without losing version choices", async () => {
    const model = modelFor([
      event("phone", now - 2 * HOUR),
      event("phone", now - HOUR, {
        app_version: "2.0.0",
        to_release_id: "bundle-b",
      }),
      event("android", now - HOUR, { platform: "android" }),
    ]);
    const report = await getAppUsageReport(
      model,
      { ...input, platform: "ios", appVersion: "1.0.0" },
      now,
    );
    expect(report.activeInstallations).toBe(1);
    expect(report.platforms).toEqual([{ name: "ios", installations: 1 }]);
    expect(report.versions).toEqual([{ name: "1.0.0", installations: 1 }]);
    expect(report.appVersions).toEqual(["2.0.0", "1.0.0"]);
    const bundles = await getRecoveryReport(
      model,
      { ...input, platform: "ios", appVersion: "1.0.0" },
      now,
    );
    // The device used v1 in this period, then left it; v1 is no longer its current bundle state.
    expect(
      bundles.series.find((series) => series.releaseId === "bundle-a")
        ?.activeInstallations,
    ).toBe(0);
    expect(
      bundles.series.some((series) => series.releaseId === "bundle-b"),
    ).toBe(false);
  });

  it("distinguishes a fully observed empty period from history beyond the read limit", async () => {
    const empty = await getAppUsageReport(modelFor([]), input, now);
    expect(empty.activeInstallations).toBe(0);
    expect(empty.points.every((point) => point.installations === 0)).toBe(true);
    const partial = await getAppUsageReport(
      modelFor([
        event("latest", now - 1),
        ...Array.from({ length: 50_000 }, (_, index) =>
          event(`older-${index}`, now - HOUR),
        ),
      ]),
      input,
      now,
    );
    expect(partial.truncated).toBe(true);
    expect(partial.activeInstallations).toBe(1);
    expect(partial.points.at(-1)?.installations).toBe(1);
    expect(
      partial.points
        .slice(0, -1)
        .every((point) => point.installations === null),
    ).toBe(true);
  });

  it("shows only the last reported bundle per installation, retaining IDs only for unchanged files in the same scope", async () => {
    const model = modelFor([
      event("updated", now - 3 * HOUR),
      event("updated", now - 2 * HOUR, {
        type: "UPDATE_APPLIED",
        app_version: "2.0.0",
        to_release_id: "bundle-b",
        to_bundle_id: "file-b",
      }),
      event("updated", now - HOUR, {
        app_version: "2.0.0",
        to_release_id: null,
        to_bundle_id: "file-b",
      }),
      event("file-changed", now - 3 * HOUR),
      event("file-changed", now - HOUR, {
        to_release_id: null,
        to_bundle_id: "file-c",
      }),
      event("channel-changed", now - 3 * HOUR, { channel: "beta" }),
      event("channel-changed", now - HOUR, { to_release_id: null }),
    ]);
    const report = await getAppUsageReport(model, input, now);
    expect(report.bundleDistribution).toEqual([
      {
        appVersion: "2.0.0",
        platform: "ios",
        releaseId: "bundle-b",
        installations: 1,
      },
      {
        appVersion: "1.0.0",
        platform: "ios",
        releaseId: null,
        installations: 2,
      },
    ]);
    expect(
      report.bundleDistribution.reduce(
        (sum, row) => sum + row.installations,
        0,
      ),
    ).toBe(report.activeInstallations);
    for (const version of report.versions) {
      expect(
        report.bundleDistribution
          .filter((row) => row.appVersion === version.name)
          .reduce((sum, row) => sum + row.installations, 0),
      ).toBe(version.installations);
    }
  });

  it("validates filters before making provider calls", async () => {
    const model = modelFor([]);
    await expect(
      getAppUsageReport(model, { ...input, appVersion: " " }, now),
    ).rejects.toThrow("Choose a platform");
    await expect(
      getAppUsageReport(model, { ...input, channel: "" }, now),
    ).rejects.toThrow("Choose a platform");
    expect(model.listEvents).not.toHaveBeenCalled();
  });
});
