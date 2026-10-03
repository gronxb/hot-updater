import { describe, expect, it } from "vitest";

import { compareStringsByCodeUnit } from "./deterministicOrder";

describe("compareStringsByCodeUnit", () => {
  it("sorts Unicode strings by stable UTF-16 code units", () => {
    expect(["ä", "z", "A", "Σ"].sort(compareStringsByCodeUnit)).toEqual([
      "A",
      "z",
      "ä",
      "Σ",
    ]);
  });
});
