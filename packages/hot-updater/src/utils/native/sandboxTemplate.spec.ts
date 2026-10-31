import fs from "node:fs";
import path from "node:path";

import { SANDBOX_CODE_MARKER } from "@hot-updater/protocol/native-artifact";
import { describe, expect, it } from "vitest";

/**
 * What keeps the sandbox layer out of a normal build, as the SDK's sources say.
 * Real builds prove the rest, on the artifact.
 */
const SDK = path.resolve(import.meta.dirname, "../../../../react-native");
const read = (file: string) => fs.readFileSync(path.join(SDK, file), "utf-8");

/** Every source file under `directory`, skipping `excluded`. */
const sourcesOf = (directory: string, excluded: string[]): string[] =>
  fs
    .readdirSync(path.join(SDK, directory), { recursive: true })
    .map(String)
    .map((file) => path.join(directory, file))
    .filter(
      (file) =>
        /\.(swift|m|mm|h|kt|java|xml|cpp)$/u.test(file) &&
        !excluded.some((prefix) => file.startsWith(prefix)),
    );

describe("the sandbox template", () => {
  it("holds the literal the artifact check reads, on both platforms", () => {
    expect(SANDBOX_CODE_MARKER).toHaveLength(32);
    expect(read("ios/HotUpdater/Sandbox/HotUpdaterSandboxMarker.m")).toContain(
      `@"${SANDBOX_CODE_MARKER}"`,
    );
    expect(
      read(
        "android/src/sandbox/java/com/hotupdater/HotUpdaterSandboxMarker.kt",
      ),
    ).toContain(`"${SANDBOX_CODE_MARKER}"`);
  });

  it("names every iOS file so the podspec's exclusion covers it", () => {
    for (const file of fs.readdirSync(
      path.join(SDK, "ios/HotUpdater/Sandbox"),
    )) {
      if (file === "README.md") continue;
      expect(file).toMatch(/^HotUpdaterSandbox/);
    }
  });

  it("excludes the iOS sources in every podspec branch", () => {
    const podspec = read("HotUpdater.podspec");
    expect(podspec).toContain('sandbox_excluded_files = "HotUpdaterSandbox*"');
    // Both pod_target_xcconfig assignments, which replace each other.
    expect(podspec.match(/pod_target_xcconfig\s*=\s*\{/gu)).toHaveLength(2);
    expect(
      podspec.match(/"EXCLUDED_SOURCE_FILE_NAMES" => sandbox_excluded_files/gu),
    ).toHaveLength(2);
    expect(podspec).not.toContain('"INCLUDED_SOURCE_FILE_NAMES" =>');
  });

  it("attaches the Android sources only with the property", () => {
    const gradle = read("android/build.gradle");
    expect(gradle).toContain('project.hasProperty("hotUpdaterSandbox")');
    const attached = gradle.match(
      /if \(isSandboxBuild\(\)\) \{[^}]*src\/sandbox\/java[^}]*src\/sandbox\/res[^}]*\}/u,
    );
    expect(attached).not.toBeNull();
    // Each mention of the directory is inside a guard.
    expect(gradle.match(/src\/sandbox\//gu)).toHaveLength(3);
  });

  it("isn't named by any normal source, so nothing needs it to compile", () => {
    const normal = [
      ...sourcesOf("ios", ["ios/HotUpdater/Sandbox"]),
      ...sourcesOf("android/src", ["android/src/sandbox"]),
    ];
    expect(normal.length).toBeGreaterThan(20);
    for (const file of normal) {
      const source = read(file);
      expect(source, file).not.toContain("HotUpdaterSandbox");
      expect(source, file).not.toContain(SANDBOX_CODE_MARKER);
    }
  });

  it("is out of the Swift package's compile lists", () => {
    const manifest = read("Package.swift");
    expect(manifest).not.toContain("Sandbox");
    expect(manifest).toContain('path: "ios/HotUpdater/Internal"');
  });
});
