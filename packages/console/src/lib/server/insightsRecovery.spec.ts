// @vitest-environment node

import type { BundleEventRow, InsightsModel } from "@hot-updater/plugin-core";
import { describe, expect, it, vi } from "vitest";

import { getBundleActivity } from "./bundleActivity";
import { getRecoveryReport } from "./insightsRecovery";

const HOUR = 3_600_000;
const now = 48 * HOUR;
const input = {
  platform: "ios",
  channel: "production",
  window: "24h",
} as const;
let sequence = 0;
const event = (
  type: BundleEventRow["type"],
  hour: number,
  releaseId = "release-a",
  overrides: Partial<BundleEventRow> = {},
): BundleEventRow =>
  ({
    id: String(++sequence).padStart(10, "0"),
    install_id: `install-${sequence}`,
    type,
    received_at_ms: hour * HOUR,
    from_bundle_id: type === "UNCHANGED" ? null : "same-file",
    to_bundle_id: "same-file",
    from_release_id: type === "RECOVERED" ? releaseId : null,
    to_release_id: type === "RECOVERED" ? "stable-release" : releaseId,
    platform: "ios",
    channel: "production",
    user_id: null,
    username: null,
    app_version: "1.0.0",
    cohort: "default",
    fingerprint_hash: null,
    sdk_version: null,
    update_strategy: type === "UNCHANGED" ? null : "appVersion",
    ...overrides,
  }) as BundleEventRow;
const reports = (
  applied: number,
  recovered: number,
  hour: number,
  id = "release-a",
) => [
  ...Array.from({ length: applied }, () => event("UPDATE_APPLIED", hour, id)),
  ...Array.from({ length: recovered }, () =>
    event("RECOVERED", hour + 0.001, id),
  ),
];
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
const seriesFor = (
  report: Awaited<ReturnType<typeof getRecoveryReport>>,
  id = "release-a",
) => report.series.find((s) => s.releaseId === id)!;
const pointAt = (
  report: Awaited<ReturnType<typeof getRecoveryReport>>,
  hour: number,
  id = "release-a",
) => seriesFor(report, id).points.find((p) => p.startMs === hour * HOUR)!;

describe("observed bundle activity", () => {
  it("charts all 30-day IDs and transfers installations between same-file promotions, producing a crossover", async () => {
    const events = [
      ...Array.from({ length: 10 }, (_, i) =>
        event("UPDATE_APPLIED", 25, "old-id", { install_id: `device-${i}` }),
      ),
      ...Array.from({ length: 5 }, (_, i) =>
        event("UNCHANGED", 26, "new-id", {
          install_id: `device-${i}`,
          from_release_id: "old-id",
        }),
      ),
      ...Array.from({ length: 4 }, (_, i) =>
        event("UNCHANGED", 27, "new-id", {
          install_id: `device-${i + 5}`,
          from_release_id: "old-id",
        }),
      ),
      event("UNCHANGED", 27.5, "new-id", { install_id: "device-0" }),
      event("UNCHANGED", 2, "early-id", { install_id: "early-device" }),
    ];
    const report = await getRecoveryReport(
      modelFor(events),
      { ...input, window: "30d" },
      31 * 24 * HOUR,
    );
    // Reports before the rolling 30-day boundary (hour 24) are excluded.
    expect(report.series.map((s) => s.releaseId)).toEqual(["old-id", "new-id"]);
    const hourly = await getRecoveryReport(modelFor(events), input, now);
    expect(
      [25, 26, 27].map((hour) => pointAt(hourly, hour, "old-id").active),
    ).toEqual([10, 5, 1]);
    expect(
      [25, 26, 27].map((hour) => pointAt(hourly, hour, "new-id").active),
    ).toEqual([0, 5, 9]);
    // Same-file selection reports move Active counts without counting a new update.
    expect(pointAt(hourly, 26, "new-id").applied).toBe(0);
    expect(seriesFor(hourly, "new-id").firstAppliedAtMs).toBeNull();
    expect(pointAt(hourly, 24, "new-id").active).toBeNull();
    expect(pointAt(hourly, 28, "old-id").active).toBe(1);
    const detail = await getRecoveryReport(
      modelFor(events),
      { ...input, releaseId: "new-id" },
      now,
    );
    expect(detail.series).toHaveLength(1);
    expect(seriesFor(detail, "new-id").activeInstallations).toBe(9);
  });

  it("retains IDs on unchanged reports only for the same observed file and excludes unknown IDs", async () => {
    const report = await getRecoveryReport(
      modelFor([
        event("UPDATE_APPLIED", 25, "release-a", { install_id: "one" }),
        event("UNCHANGED", 26, "release-a", {
          install_id: "one",
          to_release_id: null,
        }),
        event("UNCHANGED", 26, "legacy", {
          install_id: "two",
          to_release_id: null,
        }),
        event("UNCHANGED", 27, "release-a", {
          install_id: "one",
          to_bundle_id: "different-file",
          to_release_id: null,
        }),
        event("UNCHANGED", 28, "only-unchanged-id"),
      ]),
      input,
      now,
    );
    expect(pointAt(report, 26).active).toBe(1);
    expect(pointAt(report, 27).active).toBe(0);
    expect(report.unattributedInstallations).toBe(2);
    expect(seriesFor(report, "only-unchanged-id").activeInstallations).toBe(1);
    expect(report.series.some((s) => s.releaseId === "legacy")).toBe(false);
  });

  it("removes a device that reports a different channel or platform", async () => {
    const report = await getRecoveryReport(
      modelFor([
        event("UPDATE_APPLIED", 25, "release-a", { install_id: "one" }),
        event("UNCHANGED", 26, "release-a", {
          install_id: "one",
          channel: "staging",
        }),
        event("UPDATE_APPLIED", 25, "release-a", { install_id: "two" }),
        event("UNCHANGED", 27, "release-a", {
          install_id: "two",
          platform: "android",
        }),
      ]),
      input,
      now,
    );
    expect([25, 26, 27].map((hour) => pointAt(report, hour).active)).toEqual([
      2, 1, 0,
    ]);
  });

  it("attributes rollbacks to the source ID and counts unique installations per interval and window", async () => {
    const report = await getRecoveryReport(
      modelFor([
        event("UPDATE_APPLIED", 25, "release-a", { install_id: "one" }),
        event("RECOVERED", 26, "release-a", { install_id: "one" }),
        event("RECOVERED", 26.5, "release-a", { install_id: "one" }),
        event("RECOVERED", 27, "release-a", { install_id: "one" }),
      ]),
      input,
      now,
    );
    expect(pointAt(report, 26)).toMatchObject({
      active: 0,
      recovered: 2,
      recoveredInstallations: 1,
    });
    expect(seriesFor(report).recoveredInstallations).toBe(1);
    expect(seriesFor(report, "stable-release").activeInstallations).toBe(1);
    expect(seriesFor(report, "stable-release").recoveredInstallations).toBe(0);
  });

  it("uses the agreed sample, rate and increase across gaps for both apply and adoption reports", async () => {
    const report = await getRecoveryReport(
      modelFor([
        ...reports(7, 2, 25),
        ...reports(97, 3, 26),
        ...reports(7, 3, 28),
        ...reports(7, 3, 29),
        ...reports(5, 5, 30),
        event("UNCHANGED", 28, "other-id"),
      ]),
      input,
      now,
    );
    expect(
      seriesFor(report)
        .points.filter((p) => p.spike)
        .map((p) => p.startMs),
    ).toEqual([28 * HOUR, 30 * HOUR]);
    expect(pointAt(report, 27).rate).toBeNull();
    expect(pointAt(report, 28)).toMatchObject({
      applied: 7,
      recovered: 3,
      rate: 30,
    });
    const first = await getRecoveryReport(
      modelFor(reports(7, 3, 25)),
      input,
      now,
    );
    expect(pointAt(first, 25).spike).toBe(true);
    const recoveryOnly = await getRecoveryReport(
      modelFor(reports(0, 10, 25)),
      input,
      now,
    );
    expect(pointAt(recoveryOnly, 25).spike).toBe(false);
  });

  it("does not flag recoveries before the first successful application", async () => {
    const report = await getRecoveryReport(
      modelFor([...reports(0, 3, 25), ...reports(7, 0, 25.5)]),
      input,
      now,
    );
    expect(pointAt(report, 25)).toMatchObject({ rate: 30, spike: false });
  });

  it("reads timestamp ties once and batches visible bundles without one scan per row", async () => {
    const model = modelFor([
      ...reports(198, 3, 25),
      ...Array.from({ length: 105 }, () => event("UNCHANGED", 25, "other-id")),
    ]);
    const batch = await getBundleActivity(
      model,
      [
        { platform: "ios", channel: "production", releaseId: "release-a" },
        { platform: "ios", channel: "production", releaseId: "other-id" },
        { platform: "android", channel: "production", releaseId: "android-id" },
      ],
      now,
    );
    expect(model.listEvents).toHaveBeenCalledTimes(4);
    expect(batch["release-a"].series[0]).toMatchObject({
      activeInstallations: 198,
      recoveredInstallations: 3,
    });
    expect(batch["other-id"].series[0].activeInstallations).toBe(105);
    expect(batch["android-id"].series).toEqual([]);
  });

  it("omits the partially scanned boundary interval at 50,000 rows and suppresses unsupported spikes", async () => {
    const model = modelFor([
      ...reports(7, 3, 47),
      ...Array.from({ length: 49_991 }, () => event("RECOVERED", 46)),
    ]);
    const report = await getRecoveryReport(model, input, now);
    expect(model.listEvents).toHaveBeenCalledTimes(500);
    expect(report.truncated).toBe(true);
    expect(report.sinceMs).toBe(47 * HOUR);
    expect(seriesFor(report).points).toHaveLength(1);
    expect(pointAt(report, 47)).toMatchObject({
      active: 7,
      applied: 7,
      recovered: 3,
      recoveredInstallations: 3,
      rate: 30,
      spike: false,
    });
  });

  it("validates scope before reading events", async () => {
    const model = modelFor([]);
    await expect(
      getRecoveryReport(model, { ...input, channel: "" }, now),
    ).rejects.toThrow("Choose a platform");
    expect(model.listEvents).not.toHaveBeenCalled();
  });
});
