import { describe, expect, it } from "vitest";

import { isCI, nonInteractiveReason } from "./interactive";

describe("isCI", () => {
  it.each(["true", "1", "TRUE", "yes", "woodpecker"])(
    "is true when CI is %s",
    (value) => {
      expect(isCI({ CI: value })).toBe(true);
    },
  );

  it.each([undefined, "", "0", "false", " False "])(
    "is false when CI is %s",
    (value) => {
      expect(isCI({ CI: value })).toBe(false);
    },
  );
});

describe("nonInteractiveReason", () => {
  it("names CI even on a terminal, where a runner may allocate one", () => {
    expect(
      nonInteractiveReason({ env: { CI: "true" }, input: { isTTY: true } }),
    ).toBe("in CI (CI is set)");
  });

  it("names the missing terminal outside CI", () => {
    expect(nonInteractiveReason({ env: {}, input: {} })).toBe(
      "without a terminal",
    );
  });

  it("is undefined on a terminal outside CI", () => {
    expect(
      nonInteractiveReason({ env: { CI: "false" }, input: { isTTY: true } }),
    ).toBeUndefined();
  });
});
