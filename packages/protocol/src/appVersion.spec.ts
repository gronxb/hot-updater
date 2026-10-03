import { describe, expect, it } from "vitest";

import { canonicalizeAppVersion } from "./appVersion";

describe("canonicalizeAppVersion", () => {
  it.each<[string, string | null]>([
    ["1.2.3", "1.2.3"],
    ["v1.4", "1.4.0"],
    ["release-1.2.3", "1.2.3"],
    ["1.2.3-rc.1+build.7", "1.2.3"],
    ["2.5.0+build.7", "2.5.0"],
    ["", null],
    ["not-a-version", null],
  ])("canonicalizes %j to %j", (appVersion, expected) => {
    expect(canonicalizeAppVersion(appVersion)).toBe(expected);
  });
});
