import { describe, expect, it } from "vitest";

import { banner } from "./banner";

describe("banner", () => {
  it("uses engine-neutral product messaging", () => {
    const output = banner("1.2.3");

    expect(output).toContain("Hot Updater - Self-hosted OTA Updates");
    expect(output).toContain("v1.2.3");
    expect(output).not.toContain("React Native");
  });
});
