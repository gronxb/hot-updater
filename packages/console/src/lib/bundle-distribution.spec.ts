import type { InsightsGetDistributionHistoryResult } from "@hot-updater/server/plugins/insights";
import { describe, expect, it } from "vitest";

import { bundleDistributionChart } from "./bundle-distribution";

const row = (
  releaseId: string | null,
  installations: number,
  appVersion = "1.0.0",
) => ({
  releaseId,
  installations,
  appVersion,
  bundleKind: releaseId === null ? ("builtin" as const) : ("release" as const),
});
const history: InsightsGetDistributionHistoryResult = {
  coverage: { kind: "complete", sinceMs: 0 },
  measuredAtMs: 4 * 86_400_000,
  points: [
    { startMs: 0, bundles: [row("old", 80), row("new", 20)] },
    {
      startMs: 86_400_000,
      bundles: [row("old", 20), row("new", 70), row(null, 10)],
    },
    { startMs: 2 * 86_400_000, bundles: [] },
    { startMs: 3 * 86_400_000, bundles: [row("new", 10, "2.0.0")] },
  ],
};

describe("observed bundle shares", () => {
  it("shows replacement, includes built-in in the denominator, and leaves unobserved days as gaps", () => {
    const chart = bundleDistributionChart(history);
    const key = chart.series.find((series) => series.id === "new")!.key;
    expect(chart.points.map((point) => Reflect.get(point, key))).toEqual([
      20,
      70,
      null,
      100,
    ]);
    expect(chart.points[1]!.total).toBe(100);
    expect(chart.points[1]!.installations[key]).toBe(70);
  });
  it("filters app versions before counting and keeps other bundles in a selected release's denominator", () => {
    const chart = bundleDistributionChart(history, "1.0.0", "new");
    expect(chart.series.map((series) => series.id)).toEqual(["new", "other"]);
    expect(chart.points[1]).toMatchObject({
      bundle0: 70,
      bundle1: 30,
      total: 100,
    });
    expect(chart.points[3]).toMatchObject({
      bundle0: null,
      bundle1: null,
      total: 0,
    });
  });
  it("keeps a newly observed low-share release visible and groups the rest without losing their counts", () => {
    const chart = bundleDistributionChart({
      ...history,
      points: [
        {
          startMs: 0,
          bundles: [
            row("a", 40),
            row("b", 25),
            row("c", 20),
            row("d", 10),
            row("e", 4),
            row("z", 1),
          ],
        },
      ],
    });
    expect(chart.series.map((series) => series.id)).toEqual([
      "z",
      "a",
      "b",
      "c",
      "other",
    ]);
    expect(chart.points[0]).toMatchObject({ bundle0: 1, total: 100 });
    expect(chart.points[0]!.bundle4).toBeCloseTo(14);
  });
});
