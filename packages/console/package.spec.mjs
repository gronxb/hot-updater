import { describe, expect, it } from "vitest";
import packageJson from "./package.json" with { type: "json" };

describe("@hot-updater/console package metadata", () => {
  it("publishes component and hosted server helpers instead of a console binary", () => {
    expect(packageJson.bin).toBeUndefined();
    expect(packageJson.exports).toMatchObject({
      ".": {
        types: "./src/embedded.tsx",
        import: "./dist/embedded.mjs",
      },
      "./hosted": {
        types: "./src/hosted.ts",
        import: "./dist/hosted.mjs",
      },
    });
    expect(packageJson.files).toContain(".output");
    expect(packageJson.files).toContain("dist");
    expect(packageJson.files).toContain("src");
    expect(packageJson.files).toContain("public");
    expect(packageJson.exports).not.toHaveProperty("./vite");
  });
});
