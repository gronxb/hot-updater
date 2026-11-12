import { describe, expect, it } from "vitest";

import {
  hasReleaseFilters,
  releaseFilterOf,
  resolveReleaseSearch,
  showsDefaultReleases,
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

  describe("the channel the list opens on", () => {
    const production = { id: "channel-p", name: "production" };
    const staging = { id: "channel-s", name: "staging" };
    const channels = [staging, production];
    const filterOf = (
      url: Record<string, unknown>,
      rows: typeof channels | undefined,
    ) => {
      const view = resolveReleaseSearch(validateReleaseSearch(url), rows);
      return view && releaseFilterOf(view);
    };

    it("opens on production's iOS releases, keeping the page", () => {
      expect(filterOf({}, channels)).toEqual({
        kind: "channelPlatform",
        channelId: "channel-p",
        platform: "ios",
      });
      expect(
        resolveReleaseSearch(
          validateReleaseSearch({ beforeReleaseId: "r-9" }),
          channels,
        )?.beforeReleaseId,
      ).toBe("r-9");
    });

    it("waits for the channel list, and opens on every channel without production", () => {
      expect(filterOf({}, undefined)).toBeUndefined();
      expect(filterOf({}, [staging])).toEqual({ kind: "all" });
    });

    it("keeps every channel when the URL says so, and drops that beside a filter", () => {
      expect(validateReleaseSearch({ channels: "all" }).channels).toBe("all");
      expect(filterOf({ channels: "all" }, undefined)).toEqual({
        kind: "all",
      });
      expect(
        validateReleaseSearch({ channels: "all", channelId: "c" }).channels,
      ).toBeUndefined();
      expect(validateReleaseSearch({ channels: "every" }).channels).toBe(
        undefined,
      );
    });

    it("lands a link where it points: a channel, bundle, scope, or one release in every channel", () => {
      expect(filterOf({ channelId: "channel-s" }, undefined)).toEqual({
        kind: "channelPlatform",
        channelId: "channel-s",
        platform: "ios",
      });
      expect(filterOf({ bundleId: "b" }, undefined)).toEqual({
        kind: "bundle",
        bundleId: "b",
      });
      expect(filterOf({ scopeKey: "s" }, undefined)).toEqual({
        kind: "scope",
        scopeKey: "s",
      });
      // The release's row shows wherever it is, and the list stays there.
      expect(
        resolveReleaseSearch(
          validateReleaseSearch({ releaseId: "r-1" }),
          undefined,
        ),
      ).toMatchObject({ channels: "all", releaseId: "r-1" });
    });

    it("chooses every channel, or one, from the filter", () => {
      const opening = resolveReleaseSearch({}, channels)!;
      expect(
        updateReleaseFilters(opening, {
          channelId: undefined,
          channels: "all",
        }).channels,
      ).toBe("all");
      const all = validateReleaseSearch({ channels: "all" });
      expect(
        updateReleaseFilters(all, { channelId: "channel-s" }),
      ).toMatchObject({
        channelId: "channel-s",
        channels: undefined,
        platform: "ios",
      });
      expect(
        updateReleaseFilters(opening, { platform: "android" }),
      ).toMatchObject({ channelId: "channel-p", platform: "android" });
    });

    it("has nothing to clear on the list it opens on", () => {
      expect(showsDefaultReleases({}, channels)).toBe(true);
      expect(showsDefaultReleases({}, undefined)).toBe(true);
      expect(
        showsDefaultReleases(
          validateReleaseSearch({ channelId: "channel-p" }),
          channels,
        ),
      ).toBe(true);
      expect(
        showsDefaultReleases(validateReleaseSearch({ channels: "all" }), [
          staging,
        ]),
      ).toBe(true);
      expect(
        showsDefaultReleases(
          validateReleaseSearch({ channels: "all" }),
          channels,
        ),
      ).toBe(false);
      expect(
        showsDefaultReleases(
          validateReleaseSearch({
            channelId: "channel-p",
            platform: "android",
          }),
          channels,
        ),
      ).toBe(false);
    });
  });
});
