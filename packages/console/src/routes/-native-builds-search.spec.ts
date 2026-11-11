import { describe, expect, it } from "vitest";

import {
  validateNativeBuildDetailSearch,
  validateNativeBuildsSearch,
} from "./-native-builds-search";

describe("native build list search", () => {
  it("keeps a channel name and one page direction", () => {
    expect(
      validateNativeBuildsSearch({
        channel: "pr-130",
        before: "b",
        after: "a",
      }),
    ).toEqual({ channel: "pr-130", before: "b" });
    expect(validateNativeBuildsSearch({ after: "a" })).toEqual({ after: "a" });
    expect(validateNativeBuildsSearch({})).toEqual({});
  });

  it("drops a value that is no channel name", () => {
    expect(validateNativeBuildsSearch({ channel: " pr-130" })).toEqual({});
    expect(validateNativeBuildsSearch({ channel: 130 })).toEqual({});
  });
});

describe("native build list view", () => {
  it("keeps the older builds open, and only as true", () => {
    expect(
      validateNativeBuildsSearch({ channel: "pr-130", showOlder: "true" }),
    ).toEqual({ channel: "pr-130", showOlder: true });
    expect(validateNativeBuildsSearch({ showOlder: true })).toEqual({
      showOlder: true,
    });
    expect(validateNativeBuildsSearch({ showOlder: "false" })).toEqual({});
    expect(validateNativeBuildsSearch({ showOlder: "1" })).toEqual({});
  });
});

describe("native build page search", () => {
  it("keeps one page of patches", () => {
    expect(
      validateNativeBuildDetailSearch({
        patchesBefore: "b",
        patchesAfter: "a",
        build: "x",
      }),
    ).toEqual({ patchesBefore: "b" });
    expect(validateNativeBuildDetailSearch({ patchesAfter: "a" })).toEqual({
      patchesAfter: "a",
    });
  });
});
