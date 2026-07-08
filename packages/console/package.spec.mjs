import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { describe, expect, it } from "vitest";
import packageJson from "./package.json" with { type: "json" };

const packageDir = process.cwd();

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
      "./config": {
        types: "./types/config.d.ts",
        import: "./dist/config.mjs",
      },
      "./vite": {
        types: "./types/vite.d.ts",
        import: "./dist/vite.mjs",
      },
    });
    expect(packageJson.files).toContain(".output");
    expect(packageJson.files).toContain("dist");
    expect(packageJson.files).toContain("src");
    expect(packageJson.files).toContain("types");
    expect(packageJson.files).toContain("public");
    expect(packageJson.dependencies).toBeUndefined();
  });

  it("omits dev-only metadata from the packed manifest", () => {
    const packDir = mkdtempSync(join(tmpdir(), "hot-updater-console-pack-"));

    try {
      const packOutput = execFileSync(
        "pnpm",
        ["pack", "--json", "--pack-destination", packDir],
        { cwd: packageDir, encoding: "utf8" },
      );
      const jsonStart = packOutput.indexOf("{");
      expect(jsonStart).toBeGreaterThanOrEqual(0);

      const packData = JSON.parse(packOutput.slice(jsonStart));
      const packageArchive = isAbsolute(packData.filename)
        ? packData.filename
        : join(packDir, packData.filename);
      const manifestJson = execFileSync(
        "tar",
        ["-xOf", packageArchive, "package/package.json"],
        { encoding: "utf8" },
      );
      const packedManifest = JSON.parse(manifestJson);

      expect(packedManifest.devDependencies).toBeUndefined();
      expect(packedManifest.scripts?.prepack).toBeUndefined();
      expect(packedManifest.scripts?.postpack).toBeUndefined();
    } finally {
      rmSync(packDir, { recursive: true, force: true });
    }
  });
});
