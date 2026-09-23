import { describe, expect, it } from "vitest";

import {
  hasReleaseFilters,
  releaseFilterOf,
  updateReleaseFilters,
  validateReleaseSearch,
} from "./-releases-search";

describe("Release search state", () => {
  it("keeps only the filter sets the release indexes serve", () => {
    expect(
      validateReleaseSearch({
        enabled: "false",
        page: "3",
        platform: "android",
        releaseId: " release-1 ",
        targetAppVersion: " 1.2.x ",
      }),
    ).toEqual({
      afterReleaseId: undefined,
      beforeReleaseId: undefined,
      bundleId: undefined,
      channelId: undefined,
      enabled: undefined,
      platform: undefined,
      releaseId: "release-1",
      scopeKey: undefined,
    });
    expect(
      releaseFilterOf(
        validateReleaseSearch({ channelId: "channel-1", enabled: "true" }),
      ),
    ).toEqual({
      kind: "channelPlatform",
      channelId: "channel-1",
      platform: "ios",
      enabled: true,
    });
    expect(
      releaseFilterOf(
        validateReleaseSearch({ bundleId: "bundle-1", channelId: "channel-1" }),
      ),
    ).toEqual({ kind: "bundle", bundleId: "bundle-1" });
    expect(
      releaseFilterOf(
        validateReleaseSearch({ scopeKey: "scope-1", enabled: "false" }),
      ),
    ).toEqual({ kind: "scope", scopeKey: "scope-1", enabled: false });
    expect(hasReleaseFilters(validateReleaseSearch({}))).toBe(false);
  });

  it("keeps only one cursor and starts over when a filter changes", () => {
    const parsed = validateReleaseSearch({
      afterReleaseId: "newer",
      beforeReleaseId: "older",
      channelId: "channel-1",
      platform: "ios",
      releaseId: "release-4",
    });
    expect(parsed.afterReleaseId).toBeUndefined();
    expect(parsed.beforeReleaseId).toBe("older");

    expect(updateReleaseFilters(parsed, { platform: "android" })).toEqual({
      afterReleaseId: undefined,
      beforeReleaseId: undefined,
      bundleId: undefined,
      channelId: "channel-1",
      enabled: undefined,
      platform: "android",
      releaseId: undefined,
      scopeKey: undefined,
    });
  });

  it("lets a bundle or scope filter replace the channel, and a channel clear them", () => {
    const channel = validateReleaseSearch({
      channelId: "channel-1",
      enabled: "true",
    });

    const byBundle = updateReleaseFilters(channel, { bundleId: "bundle-1" });
    expect(releaseFilterOf(byBundle)).toEqual({
      kind: "bundle",
      bundleId: "bundle-1",
    });
    expect(
      releaseFilterOf(updateReleaseFilters(byBundle, { channelId: "c-2" })),
    ).toEqual({ kind: "channelPlatform", channelId: "c-2", platform: "ios" });
    expect(
      releaseFilterOf(updateReleaseFilters(channel, { scopeKey: "scope-1" })),
    ).toEqual({ kind: "scope", scopeKey: "scope-1", enabled: true });
    expect(
      releaseFilterOf(updateReleaseFilters(byBundle, { bundleId: undefined })),
    ).toEqual({ kind: "all" });
  });
});
