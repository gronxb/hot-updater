import { describe, expect, it } from "vitest";
import { filterCompatibleAppVersions } from "./filterCompatibleAppVersions";

describe("filterCompatibleAppVersions", () => {
  it("should filter and sort compatible versions", () => {
    const targetVersions = ["1.0.0", ">=1.2.0", "2.0.0"];
    const currentVersion = "1.5.0";

    const result = filterCompatibleAppVersions(targetVersions, currentVersion);

    expect(result).toEqual([">=1.2.0"]);
  });

  it("should filter and sort compatible versions", () => {
    const targetVersions = ["1.0.0", "1.0.1"];
    const currentVersion = "1.0.0";

    const result = filterCompatibleAppVersions(targetVersions, currentVersion);

    expect(result).toEqual(["1.0.0"]);
  });

  it("should handle semver ranges and wildcards", () => {
    const targetVersions = ["*", "^1.0.0", "~2.0.0", ">=1.5.0"];
    const currentVersion = "2.0.1";

    const result = filterCompatibleAppVersions(targetVersions, currentVersion);

    expect(result).toEqual(["~2.0.0", ">=1.5.0", "*"]);
  });

  it("should return empty array for incompatible versions", () => {
    const targetVersions = ["1.0.0", "1.1.0"];
    const currentVersion = "2.0.0";

    const result = filterCompatibleAppVersions(targetVersions, currentVersion);

    expect(result).toEqual([]);
  });

  it("should handle invalid version strings", () => {
    const targetVersions = ["invalid", "1.0.0", ">=1.0.0"];
    const currentVersion = "1.0.0";

    const result = filterCompatibleAppVersions(targetVersions, currentVersion);

    expect(result).toEqual(["1.0.0", ">=1.0.0"]);
  });

  it("should return empty array for invalid current version", () => {
    const targetVersions = ["1.0.0", "2.0.0"];
    const currentVersion = "invalid";

    const result = filterCompatibleAppVersions(targetVersions, currentVersion);

    expect(result).toEqual([]);
  });
});
