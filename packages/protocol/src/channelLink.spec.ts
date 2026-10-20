import { describe, expect, it } from "vitest";

import { createChannelLink, parseChannelLink } from "./channelLink";

describe("channel links", () => {
  it("joins a scheme or a universal link prefix with the encoded channel", () => {
    expect(createChannelLink("myapp://", "pr-12")).toBe(
      "myapp://hot-updater/channel/pr-12",
    );
    expect(createChannelLink("https://example.com/app", "feature/a b")).toBe(
      "https://example.com/app/hot-updater/channel/feature%2Fa%20b",
    );
    expect(() => createChannelLink("myapp://", " pr-12")).toThrow(
      "Channel name must be non-empty",
    );
  });

  it("reads the channel back from the links it creates", () => {
    for (const channel of ["pr-12", "feature/a b", "베타"]) {
      expect(parseChannelLink(createChannelLink("myapp://", channel))).toBe(
        channel,
      );
      expect(
        parseChannelLink(createChannelLink("https://example.com/", channel)),
      ).toBe(channel);
    }
  });

  it("ignores a query, a fragment, and a trailing slash", () => {
    expect(parseChannelLink("myapp://hot-updater/channel/pr-12/?a=1#b")).toBe(
      "pr-12",
    );
    expect(parseChannelLink("myapp:///hot-updater/channel/pr-12")).toBe(
      "pr-12",
    );
  });

  it("reads any other URL as null", () => {
    for (const url of [
      "myapp://settings",
      "myapp://hot-updater/channel/",
      "myapp://hot-updater/channel/pr-12/extra",
      "myapp://my-hot-updater/channel/pr-12",
      "myapp://hot-updater/channel/%E0%A4%A",
      "myapp://hot-updater/channel/%20pr-12",
    ]) {
      expect(parseChannelLink(url), url).toBeNull();
    }
  });
});
