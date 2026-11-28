import { describe, expect, it } from "vitest";

import {
  resolveNativeBuildsSearch,
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

describe("the channel the native build list opens on", () => {
  const names = ["pr-130", "production"];
  const resolve = (
    url: Record<string, unknown>,
    channelNames: readonly string[] | undefined,
  ) => resolveNativeBuildsSearch(validateNativeBuildsSearch(url), channelNames);

  it("opens on production, keeping the page", () => {
    expect(resolve({}, names)).toEqual({ channel: "production" });
    expect(resolve({ before: "b" }, names)).toEqual({
      channel: "production",
      before: "b",
    });
  });

  it("waits for the channel names, and opens on every channel without production", () => {
    expect(resolve({}, undefined)).toBeUndefined();
    expect(resolve({}, ["pr-130"])).toEqual({});
  });

  it("lists every channel when the URL says so, apart from a channel named all", () => {
    expect(validateNativeBuildsSearch({ channels: "all" })).toEqual({
      channels: "all",
    });
    expect(resolve({ channels: "all", after: "a" }, undefined)).toEqual({
      after: "a",
    });
    expect(resolve({ channel: "all" }, undefined)).toEqual({ channel: "all" });
    expect(
      validateNativeBuildsSearch({ channel: "pr-130", channels: "all" }),
    ).toEqual({ channel: "pr-130" });
  });

  it("keeps a linked channel", () => {
    expect(resolve({ channel: "pr-130" }, undefined)).toEqual({
      channel: "pr-130",
    });
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
