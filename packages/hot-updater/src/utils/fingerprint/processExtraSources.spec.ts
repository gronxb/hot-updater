import path from "path";

import { createFingerprintAsync } from "@expo/fingerprint";
import { getCwd } from "@hot-updater/cli-tools";
import { describe, expect, it } from "vitest";

import {
  processExtraSources,
  resolveExtraSources,
} from "./processExtraSources";

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

describe("resolveExtraSources", () => {
  it("should apply an array to both platforms", () => {
    const extraSources = ["resources/**", ".gitignore"];

    expect(resolveExtraSources(extraSources, "ios")).toEqual(extraSources);
    expect(resolveExtraSources(extraSources, "android")).toEqual(extraSources);
  });

  it("should scope the object form to the requested platform", () => {
    const extraSources = {
      ios: ["ios/.env"],
      android: ["android/local.properties"],
    };

    expect(resolveExtraSources(extraSources, "ios")).toEqual(["ios/.env"]);
    expect(resolveExtraSources(extraSources, "android")).toEqual([
      "android/local.properties",
    ]);
  });

  it("should return an empty array for a platform without entries", () => {
    expect(resolveExtraSources({ ios: ["ios/.env"] }, "android")).toEqual([]);
    expect(resolveExtraSources({}, "ios")).toEqual([]);
  });

  it("should handle undefined", () => {
    expect(resolveExtraSources(undefined, "ios")).toEqual([]);
    expect(resolveExtraSources(undefined, "android")).toEqual([]);
  });
});
