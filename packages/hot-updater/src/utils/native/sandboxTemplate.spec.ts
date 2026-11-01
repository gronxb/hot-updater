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
    expect(gradle.match(/src\/sandbox\//gu)).toHaveLength(4);
    expect(gradle).toMatch(
      /if \(isSandboxBuild\(\)\) \{\s*apply from: "\$projectDir\/src\/sandbox\/hot-updater-sandbox\.gradle"\s*\}/u,
    );
  });

  it("replaces HotUpdaterImpl only through what the generator reads", () => {
    const script = read("android/src/sandbox/hot-updater-sandbox.gradle");
    const generator = read(
      "android/src/sandbox/HotUpdaterSandboxImplGenerator.groovy",
    );
    const impl = read(
      "android/src/main/java/com/hotupdater/HotUpdaterImpl.kt",
    );
    // The compile tasks drop the packaged file, and only that name.
    expect(script).toContain('"**/com/hotupdater/HotUpdaterImpl.kt"');
    expect(script).toContain('"com/hotupdater/HotUpdaterImplSandbox.kt"');
    // The structure the generator refuses without, in the source this build packages.
    for (const line of [
      "class HotUpdaterImpl {",
      "    fun getJSBundleFile(): String {",
      "        val bundleUrl = prepareLaunchIfNeeded().bundleUrl",
      "    private fun restartApplication(reactContext: Context): Boolean {",
      "        this.bundleStorage = bundleStorage",
      "        this.preferences = preferences",
      "        this.keyValueStorage = KeyValueStorageService(environment.keyValueStorageFile(this.context))",
    ]) {
      expect(generator, line).toContain(line.trim());
      expect(impl.split("\n").filter((text) => text === line), line).toHaveLength(1);
    }
    // Its insertions hold for main only.
    expect(generator).toContain(
      "if (environment.isMain) HotUpdaterSandboxDev.bundleOfThisProcess(context)",
    );
    expect(generator).toContain(
      "if (environment.isMain && HotUpdaterSandboxDev.relaunch(reactContext))",
    );
    // The key the dev preferences answer for is the one the impl reads.
    expect(impl).toContain('CHANNEL_STORAGE_KEY = "HotUpdaterChannel"');
    expect(
      read("android/src/sandbox/java/com/hotupdater/HotUpdaterSandboxDev.kt"),
    ).toContain('CHANNEL_STORAGE_KEY = "HotUpdaterChannel"');
  });

  it("overrides what the bridge calls on the iOS impl", () => {
    const override = read(
      "ios/HotUpdater/Sandbox/HotUpdaterSandboxDevOverride.m",
    );
    const impl = read("ios/HotUpdater/Internal/HotUpdaterImpl.swift");
    // The Swift name of `HotUpdaterImpl` in the `HotUpdater` module.
    expect(override).toContain('"_TtC10HotUpdater14HotUpdaterImpl"');
    expect(impl).toContain("@objcMembers public class HotUpdaterImpl: NSObject");
    for (const declaration of [
      "public func bundleURL(bundle: Bundle = Bundle.main) -> URL?",
      "public func getChannel() -> String",
      "public func getActiveUpdateState() -> [String: Any]",
      "public func getBundleId() -> String?",
      "public func getBaseURL() -> String?",
      "public func getManifest() -> ManifestAssets",
      "public func notifyAppReady() -> [String: Any]",
      "public func getCrashHistory() -> [String]",
      "public func clearCrashHistory() -> Bool",
      "public func acceptReleaseCatalog(_ params: [AnyHashable: Any]?) -> Bool",
      "public func isReleaseSelectionCurrent(_ params: [AnyHashable: Any]?) -> Bool",
      "public func getStorageItem(_ key: String) -> String?",
      "public func setStorageItem(_ key: String, value: String?)",
    ]) {
      expect(impl, declaration).toContain(declaration);
    }
    // Nothing from the bridge reaches these without going through the override.
    const bridge = read("ios/HotUpdater/Internal/HotUpdater.mm");
    expect(bridge).toContain("[impl bundleURLWithBundle:");
    expect(bridge).toContain("[HotUpdaterNativeUpdates() takeEventsWithImpl:");
    expect(bridge).toContain("[HotUpdaterNativeUpdates() resetChannelWithImpl:");
    expect(bridge).toContain(
      "[HotUpdaterNativeUpdates() resetChannelIfSelectionCurrentWithImpl:",
    );
  });

  it("gives dev JavaScript a channel without releases, the same on both platforms", () => {
    const channel = "hot-updater-sandbox-dev-server";
    expect(
      read("android/src/sandbox/java/com/hotupdater/HotUpdaterSandboxDev.kt"),
    ).toContain(`DEV_CHANNEL = "${channel}"`);
    expect(
      read("ios/HotUpdater/Sandbox/HotUpdaterSandboxDevOverride.m"),
    ).toContain(`kDevChannel = @"${channel}"`);
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
