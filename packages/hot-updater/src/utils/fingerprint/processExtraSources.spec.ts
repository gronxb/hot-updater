import { createFingerprintAsync } from "@expo/fingerprint";
import { getCwd } from "@hot-updater/cli-tools";
import path from "path";
import { describe, expect, it } from "vitest";
import { processExtraSources } from "./processExtraSources";

describe("processExtraSources", () => {
  it("should return relative paths, not absolute paths", () => {
    const extraSources = [
      "packages/hot-updater/src/utils/fingerprint/processExtraSources.ts",
    ];
    const cwd = getCwd();
    const processedSources = processExtraSources(extraSources, cwd);

    expect(processedSources.length).toBeGreaterThan(0);

    for (const source of processedSources) {
      if (source.type === "dir") {
        expect(path.isAbsolute(source.filePath)).toBe(false);
      } else if (source.type === "contents") {
        expect(path.isAbsolute(source.id)).toBe(false);
      }
    }
  });

  it("should handle full file paths", () => {
    const extraSources = [
      "packages/hot-updater/src/utils/fingerprint/processExtraSources.ts",
    ];
    const cwd = getCwd();
    const processedSources = processExtraSources(extraSources, cwd);

    expect(processedSources.length).toBeGreaterThan(0);

    const source = processedSources[0];

    if (source?.type === "contents") {
      expect(source.id).toBe(extraSources[0] ?? "");
      expect(source.contents).toBeDefined();
    }
  });

  it("should handle glob patterns", () => {
    const extraSources = [
      "packages/hot-updater/src/utils/fingerprint/*.{ts}",
      "packages/hot-updater/src/commands/**/*",
    ];
    const cwd = getCwd();
    const processedSources = processExtraSources(extraSources, cwd);

    expect(processedSources.length).toBeGreaterThan(0);

    for (const source of processedSources) {
      if (source.type === "dir") {
        expect(source.filePath).toBeDefined();
      } else if (source.type === "contents") {
        expect(source.id).toBeDefined();
        expect(source.contents).toBeDefined();
      }
    }
  });

  it("should work correctly when passing directory glob patterns to @expo/fingerprint", async () => {
    const extraSources = ["packages/hot-updater/src/utils/**/*"];
    const cwd = getCwd();
    const processedSources = processExtraSources(extraSources, cwd);

    expect(processedSources.length).toBeGreaterThan(0);

    const result = await createFingerprintAsync(cwd, {
      extraSources: processedSources,
    });

    expect(result).toBeDefined();
    expect(result.hash).toBeDefined();
  });
});
