import { describe, expect, it } from "vitest";

import { managedResourceUrl } from "./managedResource";

describe("managedResourceUrl", () => {
  it("creates a generation-qualified managed URL", () => {
    expect(managedResourceUrl("assets/probe.ttf", "2")).toBe(
      "hot-updater:///assets/probe.ttf?hot-updater-generation=2",
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
  });
});
