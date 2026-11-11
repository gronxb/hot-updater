import { describe, expect, it } from "vitest";

import {
  groupUnreachableReleases,
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

describe("Unreachable release groups", () => {
  const row = (id: string, currentlyUnreachable: boolean) => ({
    id,
    currentlyUnreachable,
  });
  const ids = (rows: readonly { readonly id: string }[]) =>
    rows.map(({ id }) => id);
  const page = [
    row("r5", false),
    row("r4", true),
    row("r3", false),
    row("r2", true),
    row("r1", true),
  ];

  it("collapses a page's unreachable releases under the others, in order", () => {
    const groups = groupUnreachableReleases(page, {});
    expect(ids(groups.shown)).toEqual(["r5", "r3"]);
    expect(ids(groups.collapsed)).toEqual(["r4", "r2", "r1"]);
  });

  it("keeps the selected release where it is, and out of the count", () => {
    const groups = groupUnreachableReleases(page, { releaseId: "r2" });
    expect(ids(groups.shown)).toEqual(["r5", "r3", "r2"]);
    expect(ids(groups.collapsed)).toEqual(["r4", "r1"]);
  });

  it("keeps the selected release in an open group, so selecting it moves no row", () => {
    const groups = groupUnreachableReleases(page, {
      releaseId: "r2",
      showUnreachable: true,
    });
    expect(ids(groups.shown)).toEqual(["r5", "r3"]);
    expect(ids(groups.collapsed)).toEqual(["r4", "r2", "r1"]);
  });

  it("collapses none under a filter that asks for unreachable releases", () => {
    for (const search of [
      validateReleaseSearch({ channelId: "c", enabled: "false" }),
      validateReleaseSearch({ scopeKey: "s", enabled: "false" }),
      validateReleaseSearch({ bundleId: "bundle-1" }),
    ]) {
      const groups = groupUnreachableReleases(page, search);
      expect(ids(groups.shown)).toEqual(["r5", "r4", "r3", "r2", "r1"]);
      expect(groups.collapsed).toEqual([]);
    }
    expect(
      ids(
        groupUnreachableReleases(
          page,
          validateReleaseSearch({ channelId: "c", enabled: "true" }),
        ).collapsed,
      ),
    ).toEqual(["r4", "r2", "r1"]);
  });

  it("collapses none on a page with no other release", () => {
    const unreachable = [row("r2", true), row("r1", true)];
    expect(groupUnreachableReleases(unreachable, {})).toEqual({
      shown: unreachable,
      collapsed: [],
    });
    expect(groupUnreachableReleases([], {})).toEqual({
      shown: [],
      collapsed: [],
    });
    // Selecting one of them collapses none of the others.
    expect(groupUnreachableReleases(unreachable, { releaseId: "r1" })).toEqual({
      shown: unreachable,
      collapsed: [],
    });
  });

  it("keeps the open group across filters and pages, and out of every filter", () => {
    const open = validateReleaseSearch({
      channelId: "channel-1",
      showUnreachable: "true",
    });
    expect(open.showUnreachable).toBe(true);
    expect(
      validateReleaseSearch({ showUnreachable: "1" }).showUnreachable,
    ).toBe(undefined);
    expect(releaseFilterOf(open)).toEqual({
      kind: "channelPlatform",
      channelId: "channel-1",
      platform: "ios",
    });
    expect(
      hasReleaseFilters(validateReleaseSearch({ showUnreachable: true })),
    ).toBe(false);
    for (const filters of [
      { platform: "android" as const },
      { bundleId: "bundle-1" },
      { scopeKey: "scope-1" },
      { enabled: false },
      { channelId: undefined },
    ]) {
      expect(updateReleaseFilters(open, filters).showUnreachable).toBe(true);
    }
  });
});
