import { describe, expect, it } from "vitest";
import { getCommitUrl } from "./git";

describe("getCommitUrl", () => {
  it("uses the configured repository URL for GitHub commits", () => {
    expect(
      getCommitUrl("https://github.com/gronxb/hot-updater", "abc123def456"),
    ).toBe("https://github.com/gronxb/hot-updater/commit/abc123def456");
  });

  it("normalizes repository URLs that end with .git", () => {
    expect(
      getCommitUrl("https://github.com/gronxb/hot-updater.git", "abc123def456"),
    ).toBe("https://github.com/gronxb/hot-updater/commit/abc123def456");
  });

  it("supports ssh repository URLs", () => {
    expect(
      getCommitUrl("git@github.com:gronxb/hot-updater.git", "abc123"),
    ).toBe("https://github.com/gronxb/hot-updater/commit/abc123");
  });

  it("returns null when gitUrl is missing", () => {
    expect(getCommitUrl(undefined, "abc123")).toBeNull();
  });
});
