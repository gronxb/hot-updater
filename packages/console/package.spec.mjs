import { describe, expect, it } from "vitest";
import packageJson from "./package.json" with { type: "json" };

describe("@hot-updater/console package metadata", () => {
  it("publishes the console server binary", () => {
    expect(packageJson.bin).toEqual({
      "hot-updater-console": "./bin/hot-updater-console.mjs",
    });
    expect(packageJson.files).toContain(".output");
    expect(packageJson.files).toContain("bin");
  });
});
