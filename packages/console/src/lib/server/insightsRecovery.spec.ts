// @vitest-environment node

import type { BundleEventRow, InsightsModel } from "@hot-updater/plugin-core";
import { describe, expect, it, vi } from "vitest";

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
  type: "RELEASE_ADOPTED" | "RECOVERED" | "UPDATE_APPLIED",
  time: number,
  releaseId = "release-a",
  overrides: Partial<BundleEventRow> = {},
): BundleEventRow =>
  ({
    id: String(++sequence).padStart(10, "0"),
    install_id: `install-${sequence}`,
    type,
    received_at_ms: time,
    from_bundle_id: "same-file",
    to_bundle_id: "same-file",
    from_release_id: type === "RECOVERED" ? releaseId : "previous-release",
    to_release_id: type === "RECOVERED" ? "stable-release" : releaseId,
    platform: "ios",
    channel: "production",
    user_id: null,
    username: null,
    app_version: "1.0.0",
    cohort: "default",
    fingerprint_hash: null,
    sdk_version: null,
    update_strategy: "appVersion",
    ...overrides,
  }) as BundleEventRow;
const reports = (
  adopted: number,
  recovered: number,
  hour: number,
  releaseId = "release-a",
) => [
  ...Array.from({ length: adopted }, (_, i) =>
    event("RELEASE_ADOPTED", hour * HOUR + i, releaseId),
  ),
  ...Array.from({ length: recovered }, (_, i) =>
    event("RECOVERED", hour * HOUR + 1_000 + i, releaseId),
  ),
];
function modelFor(events: BundleEventRow[]): InsightsModel {
  const ordered = events.sort(
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

describe("recovery rollout series", () => {
  it("attributes recovery to the source ID and keeps promotions of the same file separate", async () => {
    const report = await getRecoveryReport(
      modelFor([
        ...reports(100, 0, 25),
        ...reports(7, 3, 26),
        ...reports(20, 0, 26, "release-b"),
        event("UPDATE_APPLIED", 26 * HOUR),
        event("RECOVERED", 26 * HOUR, "release-a", { platform: "android" }),
        event("RECOVERED", 26 * HOUR, "release-a", { channel: "staging" }),
        event("RECOVERED", 26 * HOUR, "release-a", { from_release_id: null }),
        event("RECOVERED", now),
        event("RECOVERED", 24 * HOUR - 1),
      ]),
      input,
      now,
    );
    expect(report.series.map((s) => s.releaseId)).toEqual([
      "release-a",
      "release-b",
    ]);
    expect(report.series[0].firstAdoptedAtMs).toBe(25 * HOUR);
    expect(
      report.series[0].points.find((p) => p.startMs === 26 * HOUR),
    ).toEqual({
      startMs: 26 * HOUR,
      adopted: 7,
      adoptionShare: (7 / 27) * 100,
      recovered: 3,
      rate: 30,
      spike: true,
    });
    expect(
      report.series[1].points.find((p) => p.startMs === 26 * HOUR)?.rate,
    ).toBe(0);
    expect(report.series[0].points[0].rate).toBeNull();
  });

  it("filters the sheet by its exact ID and marks first-interval rollout failures", async () => {
    const report = await getRecoveryReport(
      modelFor([...reports(7, 3, 25), ...reports(1, 30, 25, "release-b")]),
      { ...input, releaseId: "release-a" },
      now,
    );
    expect(report.series).toHaveLength(1);
    expect(report.series[0].releaseId).toBe("release-a");
    expect(
      report.series[0].points.find((p) => p.startMs === 25 * HOUR)?.spike,
    ).toBe(true);
  });

  it("requires the agreed sample, rate and increase, and compares across gaps", async () => {
    const report = await getRecoveryReport(
      modelFor([
        ...reports(7, 2, 25), // under ten reports and three recoveries
        ...reports(97, 3, 26), // below ten percent
        ...reports(7, 3, 28), // 27 percentage point rise across an empty interval
        ...reports(7, 3, 29), // high but flat
        ...reports(5, 5, 30), // another spike
      ]),
      input,
      now,
    );
    expect(
      report.series[0].points.filter((p) => p.spike).map((p) => p.startMs),
    ).toEqual([28 * HOUR, 30 * HOUR]);
    expect(
      report.series[0].points.find((p) => p.startMs === 27 * HOUR)?.rate,
    ).toBeNull();
  });

  it("shows recovery reports without claiming a rollout spike when no adoption was observed", async () => {
    const report = await getRecoveryReport(
      modelFor(reports(0, 10, 25)),
      input,
      now,
    );
    expect(report.series[0].firstAdoptedAtMs).toBeNull();
    expect(
      report.series[0].points.find((p) => p.startMs === 25 * HOUR),
    ).toMatchObject({ rate: 100, spike: false });
  });

  it("pages through timestamp ties without dropping or double-counting reports", async () => {
    const model = modelFor([
      ...reports(198, 3, 25),
      ...Array.from({ length: 105 }, () => event("RELEASE_ADOPTED", 25 * HOUR)),
    ]);
    const report = await getRecoveryReport(model, input, now);
    expect(model.listEvents).toHaveBeenCalledTimes(4);
    expect(report.truncated).toBe(false);
    expect(
      report.series[0].points.find((p) => p.startMs === 25 * HOUR),
    ).toMatchObject({ adopted: 303, recovered: 3, rate: (3 / 306) * 100 });
  });

  it("does not call recoveries before the first adoption a rollout spike", async () => {
    const report = await getRecoveryReport(
      modelFor([
        ...Array.from({ length: 3 }, () => event("RECOVERED", 25 * HOUR)),
        ...Array.from({ length: 7 }, () =>
          event("RELEASE_ADOPTED", 25 * HOUR + 1_000),
        ),
      ]),
      input,
      now,
    );
    expect(
      report.series[0].points.find((p) => p.startMs === 25 * HOUR),
    ).toMatchObject({ rate: 30, spike: false });
  });

  it("omits the incomplete boundary interval at the 50,000-row cap", async () => {
    const model = modelFor([
      ...reports(7, 3, 47),
      ...Array.from({ length: 49_991 }, () => event("RECOVERED", 46 * HOUR)),
    ]);
    const report = await getRecoveryReport(model, input, now);
    expect(model.listEvents).toHaveBeenCalledTimes(500);
    expect(report.truncated).toBe(true);
    expect(report.sinceMs).toBe(47 * HOUR);
    expect(report.series[0].points).toEqual([
      {
        startMs: 47 * HOUR,
        adopted: 7,
        adoptionShare: 100,
        recovered: 3,
        rate: 30,
        spike: false,
      },
    ]);
  });

  it("validates scope before reading events", async () => {
    const model = modelFor([]);
    await expect(
      getRecoveryReport(model, { ...input, channel: "" }, now),
    ).rejects.toThrow("Choose a platform");
    expect(model.listEvents).not.toHaveBeenCalled();
  });

  it("shows the adoption crossover of two IDs sharing a file and keeps the same denominator in the sheet", async () => {
    const events = [
      ...reports(90, 0, 25, "old-id"),
      ...reports(10, 0, 25, "new-id"),
      ...reports(50, 0, 26, "old-id"),
      ...reports(50, 0, 26, "new-id"),
      ...reports(10, 0, 27, "old-id"),
      ...reports(90, 10, 27, "new-id"),
      event("RELEASE_ADOPTED", 27 * HOUR, "other-platform", {
        platform: "android",
      }),
      event("RELEASE_ADOPTED", 27 * HOUR, "legacy", { to_release_id: null }),
    ];
    const report = await getRecoveryReport(modelFor(events), input, now);
    const shares = (id: string) =>
      report.series
        .find((s) => s.releaseId === id)
        ?.points.filter((p) => p.adoptionShare !== null)
        .map((p) => p.adoptionShare);
    expect(shares("old-id")).toEqual([90, 50, 10]);
    expect(shares("new-id")).toEqual([10, 50, 90]);
    const sheet = await getRecoveryReport(
      modelFor(events),
      { ...input, releaseId: "new-id" },
      now,
    );
    expect(sheet.series).toHaveLength(1);
    expect(
      sheet.series[0].points
        .filter((p) => p.adoptionShare !== null)
        .map((p) => p.adoptionShare),
    ).toEqual([10, 50, 90]);
  });
});
