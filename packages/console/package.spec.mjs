import { describe, expect, it } from "vitest";
import packageJson from "./package.json" with { type: "json" };

describe("@hot-updater/console package metadata", () => {
  it("publishes component and hosted server helpers instead of a console binary", () => {
    expect(packageJson.bin).toBeUndefined();
    expect(packageJson.exports).toMatchObject({
      ".": {
        types: "./types/embedded.d.ts",
        import: "./dist/embedded.mjs",
      },
      "./hosted": {
        types: "./types/hosted.d.ts",
        import: "./dist/hosted.mjs",
      },
    });
    expect(packageJson.files).toContain(".output");
    expect(packageJson.files).toContain("dist");
    expect(packageJson.files).toContain("src");
    expect(packageJson.files).toContain("types");
    expect(packageJson.files).toContain("public");
    expect(packageJson.exports).not.toHaveProperty("./vite");
  });
});
