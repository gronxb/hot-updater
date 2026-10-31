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

const GATE_SELECTORS = {
  five: "viewWithModuleName:initialProperties:launchOptions:bundleConfiguration:devMenuConfiguration:",
  three: "viewWithModuleName:initialProperties:launchOptions:",
};

/** The selector's parts, as an Objective-C declaration spreads them over lines. */
const declares = (source: string, selector: string) =>
  new RegExp(
    `- ?\\(UIView \\*[^)]*\\)${selector
      .split(":")
      .filter(Boolean)
      .map((part) => `${part}:\\([^)]*\\)\\s*\\w+`)
      .join("\\s+")}`,
    "u",
  ).test(source);

describe("the gate's hold on React Native", () => {
  const gate = read("ios/HotUpdater/Sandbox/HotUpdaterSandboxGate.m");

  it("swaps the selectors the supported hosts declare", () => {
    expect(gate).toContain(GATE_SELECTORS.five);
    expect(gate).toContain(GATE_SELECTORS.three);
    for (const [example, selector] of [
      ["v0.74.1", GATE_SELECTORS.three],
      ["v0.85.0", GATE_SELECTORS.five],
      ["v0.88.0", GATE_SELECTORS.five],
      ["expo-52", GATE_SELECTORS.three],
    ] as const) {
      const factory = path.resolve(
        SDK,
        `../../examples/${example}/node_modules/react-native/Libraries/AppDelegate/RCTRootViewFactory.mm`,
      );
      expect(
        declares(fs.readFileSync(factory, "utf-8"), selector),
        example,
      ).toBe(true);
    }
  });

  it("relaunches through the SDK's restart, which sets the flag the activity reads", () => {
    expect(
      read("android/src/main/java/com/hotupdater/HotUpdaterRestartActivity.kt"),
    ).toContain("Intent.makeRestartActivityTask(component)");
    expect(
      read("android/src/sandbox/java/com/hotupdater/HotUpdaterSandboxStart.kt"),
    ).toContain("Intent.FLAG_ACTIVITY_CLEAR_TASK != 0");
  });
});

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
      ...sourcesOf("ios", [
        "ios/HotUpdater/Sandbox",
        "ios/HotUpdater/Test/Sandbox",
        // Runs the tests above; the podspec and the published package leave it out.
        "ios/HotUpdater/Package.swift",
      ]),
      // Its prefix also covers src/sandboxTest, attached only by an init script.
      ...sourcesOf("android/src", ["android/src/sandbox"]),
    ];
    expect(normal.length).toBeGreaterThan(20);
    for (const file of normal) {
      const source = read(file);
      expect(source, file).not.toContain("HotUpdaterSandbox");
      expect(source, file).not.toContain(SANDBOX_CODE_MARKER);
    }
  });

  it("keeps its tests out of any app's build and out of the published package", () => {
    expect(read("HotUpdater.podspec")).toContain(
      '"ios/HotUpdater/Test/**/*.{swift,h,m,mm}"',
    );
    const { files } = JSON.parse(read("package.json")) as { files: string[] };
    expect(files).toContain("!ios/HotUpdater/Test");
    expect(files).toContain("!android/src/sandboxTest");
    // build.gradle names no test sources: only the tests' own init script does.
    expect(read("android/build.gradle")).not.toContain("sandboxTest");
  });

  it("is out of the Swift package's compile lists", () => {
    const manifest = read("Package.swift");
    expect(manifest).not.toContain("Sandbox");
    expect(manifest).toContain('path: "ios/HotUpdater/Internal"');
  });
});
