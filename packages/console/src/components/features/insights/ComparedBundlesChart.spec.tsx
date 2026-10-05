import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { AdoptionRelease } from "@/lib/release-adoption";

import {
  curveOf,
  spanOf,
  ticksOf,
  useSeriesColors,
} from "./ComparedBundlesChart";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// Every period ends here, with the current hour: its intervals start at 08:00.
const END = Date.UTC(2026, 9, 5, 8);

const periodOf = (durationMs: number, intervalMs: number) => ({
  startMs: END - durationMs,
  endMs: END,
  durationMs,
  intervalMs,
});

const releaseOf = (
  releaseId: string,
  deployedAtMs: number,
): AdoptionRelease => ({
  releaseId,
  bundleId: `bundle-${releaseId}`,
  deployedAtMs,
  targetAppVersion: "1.0.0",
  enabled: true,
  revision: 1,
});

describe("Release health chart", () => {
  it("puts each count at the end of its interval, from the interval its bundle was deployed in", () => {
    // 17 minutes into the interval before the last.
    const deployedAtMs = END - 12 * HOUR + 17 * 60_000;
    const curve = curveOf(periodOf(7 * DAY, 6 * HOUR), [
      {
        release: releaseOf("new", deployedAtMs),
        points: [{ startMs: END - 12 * HOUR, events: 5 }],
        measuredAtMs: END - HOUR / 2,
      },
      { release: releaseOf("old", 0), points: [], measuredAtMs: END },
      { release: releaseOf("loading", 0), points: undefined, measuredAtMs: 0 },
    ]);
    expect(curve).toHaveLength(28);
    expect(curve.at(-3)).toMatchObject({ endMs: END - 12 * HOUR, b0: null });
    expect(curve.at(-2)).toEqual({
      startMs: END - 12 * HOUR,
      endMs: END - 6 * HOUR,
      b0: 5,
      b1: 0,
      b2: null,
    });
    // The deployment comes before its first count, and an interval with no
    // reports counts none.
    expect(curve.at(-2)!.endMs).toBeGreaterThan(deployedAtMs);
    expect(curve.at(-1)).toMatchObject({ endMs: END, b0: 0 });
  });

  it("ticks on whole UTC times, so a date names its midnight", () => {
    expect(ticksOf(periodOf(DAY, HOUR))).toEqual(
      [12, 16, 20, 24, 28].map((hour) => Date.UTC(2026, 9, 4, hour)),
    );
    expect(ticksOf(periodOf(7 * DAY, 6 * HOUR))).toEqual(
      [29, 30, 31, 32, 33, 34, 35].map((day) => Date.UTC(2026, 8, day)),
    );
    expect(ticksOf(periodOf(30 * DAY, DAY))).toEqual(
      [9, 14, 19, 24, 29, 34].map((day) => Date.UTC(2026, 8, day)),
    );
  });

  it("names an interval by its start and end", () => {
    expect(spanOf(Date.UTC(2026, 9, 5, 0), Date.UTC(2026, 9, 5, 1))).toBe(
      "Oct 5, 00:00–01:00 UTC",
    );
    expect(spanOf(Date.UTC(2026, 9, 4, 20), Date.UTC(2026, 9, 5, 2))).toBe(
      "Oct 4, 20:00 – Oct 5, 02:00 UTC",
    );
  });

  it("keeps a bundle's color while others are added or removed", () => {
    const { result, rerender } = renderHook(
      ({ ids }: { ids: readonly string[] }) => useSeriesColors(ids),
      { initialProps: { ids: ["a", "b"] } },
    );
    expect(result.current("a")).toBe("var(--series-1)");
    expect(result.current("b")).toBe("var(--series-2)");
    // A new bundle takes the first free color.
    rerender({ ids: ["b", "c"] });
    expect(result.current("b")).toBe("var(--series-2)");
    expect(result.current("c")).toBe("var(--series-1)");
    rerender({ ids: ["b", "c", "d"] });
    expect(result.current("d")).toBe("var(--series-3)");
  });
});
