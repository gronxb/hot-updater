import { describe, expect, it } from "vitest";

import { readReleaseFilter } from "./listReleases";

describe("readReleaseFilter", () => {
  it("accepts the filter sets the release indexes serve", () => {
    expect(readReleaseFilter(undefined)).toEqual({ kind: "all" });
    expect(
      readReleaseFilter({
        kind: "channelPlatform",
        channelId: "c",
        platform: "ios",
        enabled: false,
      }),
    ).toEqual({
      kind: "channelPlatform",
      channelId: "c",
      platform: "ios",
      enabled: false,
    });
    expect(readReleaseFilter({ kind: "bundle", bundleId: "b" })).toEqual({
      kind: "bundle",
      bundleId: "b",
    });
    expect(readReleaseFilter({ kind: "scope", scopeKey: "s" })).toEqual({
      kind: "scope",
      scopeKey: "s",
    });
  });

  it.each([
    [{ kind: "channelPlatform", channelId: "c" }, "platform"],
    [{ kind: "channelPlatform", platform: "ios" }, "channelId"],
    [{ kind: "scope", scopeKey: "s", enabled: "yes" }, "enabled"],
    [{ kind: "platform", platform: "ios" }, "Invalid release filter."],
    [
      { kind: "targetAppVersion", targetAppVersion: "1.0" },
      "Invalid release filter.",
    ],
  ])("refuses %j", (filter, message) => {
    expect(() => readReleaseFilter(filter)).toThrow(message);
  });
});
