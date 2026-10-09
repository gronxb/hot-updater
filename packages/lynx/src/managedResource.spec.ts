import { describe, expect, it } from "vitest";

import { managedFontUrl, managedResourceUrl } from "./managedResource";

describe("managedResourceUrl", () => {
  it("creates a generation-qualified managed URL", () => {
    expect(managedResourceUrl("assets/probe.ttf", "2")).toBe(
      "hot-updater:///assets/probe.ttf?hot-updater-generation=2",
    );
  });

  it("uses the reserved font origin with a distinct cache key per generation", () => {
    expect(managedFontUrl("assets/probe.ttf", "2")).toBe(
      "https://hot-updater-font.invalid/assets/probe.ttf?hot-updater-generation=2",
    );
    expect(managedFontUrl("assets/probe.ttf", "3")).not.toBe(
      managedFontUrl("assets/probe.ttf", "2"),
    );
  });

  it("encodes Unicode, spaces, and punctuation canonically for both native readers", () => {
    expect(managedFontUrl("assets/한글 café (1)!~.ttf", "2")).toBe(
      "https://hot-updater-font.invalid/assets/%ED%95%9C%EA%B8%80%20caf%C3%A9%20%281%29%21~.ttf?hot-updater-generation=2",
    );
  });

  it.each([
    ["assets/probe.ttf", "0"],
    ["assets/probe.ttf", "02"],
    ["../probe.ttf", "2"],
    ["assets/probe.ttf?stale=1", "2"],
    ["assets/\u001fprobe.ttf", "2"],
    ["é".repeat(513), "2"],
    ["assets/\ud800.ttf", "2"],
  ])("rejects path %s at generation %s", (path, generation) => {
    expect(() => managedResourceUrl(path, generation)).toThrow(
      "Invalid managed resource URL input",
    );
    expect(() => managedFontUrl(path, generation)).toThrow(
      "Invalid managed resource URL input",
    );
  });
});
