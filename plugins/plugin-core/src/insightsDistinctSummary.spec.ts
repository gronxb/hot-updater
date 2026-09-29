import { describe, expect, it } from "vitest";

import {
  addInsightsDistinct,
  countInsightsDistinct,
  emptyInsightsDistinct,
  getInsightsDistinctRegister,
  mergeInsightsDistinct,
} from "./insightsDistinctSummary";

/** mulberry32: a seeded generator, so the sampled identities never change. */
const seeded = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
  return (value ^ (value >>> 14)) >>> 0;
};

/** A random version 4 UUID from `next`, shaped like the installation IDs apps report. */
const randomInstallId = (next: () => number) => {
  const hex = Array.from({ length: 4 }, () =>
    next().toString(16).padStart(8, "0"),
  ).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
};

describe("Insights distinct summaries", () => {
  it("merges overlapping installation populations without summing duplicates", () => {
    let first = emptyInsightsDistinct();
    let second = emptyInsightsDistinct();
    for (let index = 0; index < 5_000; index += 1) {
      first = addInsightsDistinct(first, `installation-${index}`);
    }
    for (let index = 2_500; index < 7_500; index += 1) {
      second = addInsightsDistinct(second, `installation-${index}`);
    }

    const estimate = countInsightsDistinct(
      mergeInsightsDistinct([first, second]),
    );
    expect(Math.abs(estimate - 7_500) / 7_500).toBeLessThan(0.08);
  });

  it("keeps repeated observations and empty summaries stable", () => {
    const empty = emptyInsightsDistinct();
    const once = addInsightsDistinct(empty, "installation-a");
    const repeated = addInsightsDistinct(once, "installation-a");
    expect(countInsightsDistinct(empty)).toBe(0);
    expect(repeated).toBe(once);
    expect(countInsightsDistinct(repeated)).toBe(1);
  });

  it("estimates 1k to 50k installations within a few percent", () => {
    // 1,024 registers give a standard error of 1.04 / √1024, about 3.3%.
    // Linear counting kept past its range swung by 5-10% at 4k to 10k.
    const sizes = [
      1_000, 2_500, 4_000, 5_000, 6_000, 8_000, 10_000, 20_000, 50_000,
    ];
    const trials = 8;
    const squaredErrors = sizes.map(() => 0);
    for (let trial = 0; trial < trials; trial += 1) {
      const next = seeded(trial + 1);
      // Registers are set directly: addInsightsDistinct re-encodes the whole
      // summary for each identity, which 50k identities make slow.
      const registers = [...emptyInsightsDistinct()];
      let added = 0;
      sizes.forEach((size, position) => {
        for (; added < size; added += 1) {
          const { index, character } = getInsightsDistinctRegister(
            randomInstallId(next),
          );
          if (character > registers[index]!) registers[index] = character;
        }
        const estimate = countInsightsDistinct(registers.join(""));
        squaredErrors[position]! += ((estimate - size) / size) ** 2;
      });
    }
    sizes.forEach((size, position) => {
      const rootMeanSquare = Math.sqrt(squaredErrors[position]! / trials);
      expect(rootMeanSquare, `${size} installations`).toBeLessThan(0.06);
    });
  });
});
