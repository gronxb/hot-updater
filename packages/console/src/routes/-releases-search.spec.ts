import { describe, expect, it } from "vitest";

import {
  updateReleaseFilters,
  validateReleaseSearch,
} from "./-releases-search";

describe("Release search state", () => {
  it("normalizes shareable filters and ignores invalid values", () => {
    expect(
      validateReleaseSearch({
        enabled: "false",
        page: "3",
        platform: "windows",
        releaseId: " release-1 ",
        targetAppVersion: " 1.2.x ",
      }),
    ).toEqual({
      afterReleaseId: undefined,
      beforeReleaseId: undefined,
      bundleId: undefined,
      channelId: undefined,
      enabled: false,
      page: 3,
      platform: undefined,
      releaseId: "release-1",
      targetAppVersion: "1.2.x",
    });
  });

  it("keeps only one cursor and resets paging when a filter changes", () => {
    const parsed = validateReleaseSearch({
      afterReleaseId: "newer",
      beforeReleaseId: "older",
      page: 4,
      platform: "ios",
      releaseId: "release-4",
    });
    expect(parsed.afterReleaseId).toBeUndefined();
    expect(parsed.beforeReleaseId).toBe("older");

    expect(updateReleaseFilters(parsed, { platform: "android" })).toEqual({
      ...parsed,
      afterReleaseId: undefined,
      beforeReleaseId: undefined,
      page: undefined,
      platform: "android",
      releaseId: undefined,
    });
  });
});
