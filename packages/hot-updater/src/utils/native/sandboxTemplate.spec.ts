import fs from "node:fs";
import path from "node:path";

import {
  SANDBOX_CODE_MARKER,
  SANDBOX_INFO_PLIST_KEY,
} from "@hot-updater/protocol/native-artifact";
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

const IOS_SANDBOX = "ios/HotUpdater/Sandbox";
const SANDBOX_CONDITION = "HOT_UPDATER_SANDBOX_LAYER";

/** Every file in the iOS sandbox folder but its README, however deep. */
const iosSandboxFiles = (): string[] =>
  fs
    .readdirSync(path.join(SDK, IOS_SANDBOX), { recursive: true })
    .map(String)
    .map((file) => path.join(IOS_SANDBOX, file))
    .filter(
      (file) =>
        fs.statSync(path.join(SDK, file)).isFile() && !file.endsWith(".md"),
    );

/** Whether only comments sit outside the condition's `#if` and its `#endif`. */
const isWrappedWhole = (source: string): boolean => {
  const lines = source
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("//"));
  if (lines[0] !== `#if ${SANDBOX_CONDITION}` || lines.at(-1) !== "#endif") {
    return false;
  }
  let depth = 0;
  return lines.every((line, index) => {
    if (/^#(if|ifdef|ifndef)\b/u.test(line)) depth += 1;
    if (/^#endif\b/u.test(line)) depth -= 1;
    return depth > 0 || index === lines.length - 1;
  });
};

const GATE_SELECTORS = {
  five: "viewWithModuleName:initialProperties:launchOptions:bundleConfiguration:devMenuConfiguration:",
  four: "viewWithModuleName:initialProperties:launchOptions:devMenuConfiguration:",
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
    expect(gate).toContain(GATE_SELECTORS.four);
    expect(gate).toContain(GATE_SELECTORS.three);
    for (const [example, selector] of [
      ["v0.74.1", GATE_SELECTORS.three],
      ["v0.85.0", GATE_SELECTORS.five],
      ["v0.88.0", GATE_SELECTORS.five],
      ["expo-55", GATE_SELECTORS.four],
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

  it("tells a whole wrap from anything less", () => {
    const wrap = (body: string) =>
      `#if ${SANDBOX_CONDITION}\n${body}\n#endif\n`;
    expect(isWrappedWhole(wrap("import UIKit"))).toBe(true);
    expect(isWrappedWhole(`// About it.\n/* And more. */\n${wrap("a")}`)).toBe(
      true,
    );
    expect(isWrappedWhole(wrap("#if DEBUG\na\n#else\nb\n#endif"))).toBe(true);
    expect(isWrappedWhole("import UIKit\n")).toBe(false);
    expect(isWrappedWhole("")).toBe(false);
    expect(isWrappedWhole(`import UIKit\n${wrap("a")}`)).toBe(false);
    expect(isWrappedWhole(`${wrap("a")}b\n`)).toBe(false);
    expect(isWrappedWhole(`${wrap("a")}${wrap("b")}`)).toBe(false);
    expect(isWrappedWhole("#if OTHER\na\n#endif\n")).toBe(false);
  });

  it("wraps every iOS source whole in the condition only the CLI sets", () => {
    const files = iosSandboxFiles();
    expect(files.length).toBeGreaterThan(9);
    for (const file of files) {
      expect(isWrappedWhole(read(file)), file).toBe(true);
    }
    const xcconfig = fs.readFileSync(
      path.resolve(SDK, "../apple-helper/src/utils/writeBuildXcconfig.ts"),
      "utf-8",
    );
    expect(xcconfig).toContain(`SANDBOX_CONDITION = "${SANDBOX_CONDITION}"`);
    expect(xcconfig).toContain(
      "SWIFT_ACTIVE_COMPILATION_CONDITIONS: `$(inherited) ${SANDBOX_CONDITION}`",
    );
    expect(xcconfig).toContain(
      "GCC_PREPROCESSOR_DEFINITIONS: `$(inherited) ${SANDBOX_CONDITION}=1`",
    );
  });

  it("starts only from a +load that checks the plist key first", () => {
    const guarded = new RegExp(
      `\\+ ?\\(void\\) ?load \\{\\n(?:\\s*//[^\\n]*\\n)*\\s*if \\(!\\[\\[NSBundle\\.mainBundle objectForInfoDictionaryKey:@"${SANDBOX_INFO_PLIST_KEY}"\\] isEqual:@YES\\]\\) return;`,
      "gu",
    );
    const loads = (source: string) =>
      (source.match(/\+ ?\(void\) ?load\b/gu) ?? []).length;
    expect(loads(read(`${IOS_SANDBOX}/HotUpdaterSandboxGate.m`))).toBe(1);
    for (const file of iosSandboxFiles()) {
      const source = read(file);
      expect((source.match(guarded) ?? []).length, file).toBe(loads(source));
      expect(source, file).not.toMatch(/\+ ?\(void\) ?initialize\b/u);
      expect(source, file).not.toMatch(/__attribute__\(\(constructor/u);
      // The entry points' wrappers run only from behind the gate's guard.
      if (!/HotUpdaterSandbox(Gate|EntryPoints)\.(m|h)$/u.test(file)) {
        expect(source, file).not.toContain("HotUpdaterSandboxWrap");
      }
    }
  });

  it("excludes the iOS sources in every podspec branch", () => {
    const podspec = read("HotUpdater.podspec");
    expect(podspec).toContain('sandbox_excluded_files = "HotUpdaterSandbox*"');
    // Every pod_target_xcconfig assignment, since each replaces the last.
    const assignments = podspec.match(/pod_target_xcconfig\s*=\s*\{/gu) ?? [];
    expect(assignments.length).toBeGreaterThan(0);
    expect(
      podspec.match(/"EXCLUDED_SOURCE_FILE_NAMES" => sandbox_excluded_files/gu),
    ).toHaveLength(assignments.length);
    // install_modules_dependencies extends the config set before it.
    expect(podspec.indexOf("EXCLUDED_SOURCE_FILE_NAMES")).toBeLessThan(
      podspec.indexOf("install_modules_dependencies(s)"),
    );
    expect(podspec).not.toContain('"INCLUDED_SOURCE_FILE_NAMES" =>');
  });

  it("attaches the Android sources only with the property", () => {
    const gradle = read("android/build.gradle");
    expect(gradle).toContain('project.hasProperty("hotUpdaterSandbox")');
    const attached = gradle.match(
      /if \(isSandboxBuild\(\)\) \{[^}]*src\/sandbox\/java[^}]*src\/sandbox\/res[^}]*\}/u,
    );
    expect(attached).not.toBeNull();
    // AGP's source set for a build type or flavor named `sandbox` stays empty.
    expect(gradle).toMatch(
      /sourceSets\.matching \{ it\.name == "sandbox" \}\.all \{\s+java\.srcDirs = \[\]\s+res\.srcDirs = \[\]/u,
    );
    // Each mention of the directory is inside a guard.
    expect(gradle.match(/src\/sandbox\//gu)).toHaveLength(4);
    expect(gradle).toMatch(
      /if \(isSandboxBuild\(\)\) \{\s*apply from: "\$projectDir\/src\/sandbox\/hot-updater-sandbox\.gradle"\s*\}/u,
    );
  });

  it("compiles its screen with Compose, and carries Geist, only in a sandbox build", () => {
    const gradle = read("android/build.gradle");
    // What's left once the guarded blocks are gone names neither.
    const unguarded = gradle
      .replace(
        /if \(project\.hasProperty\("hotUpdaterSandbox"\)[^{]*\{[^}]*\}/gu,
        "",
      )
      .replace(/if \(isSandboxBuild\(\)\) \{(?:[^{}]|\{[^{}]*\})*\}/gu, "");
    expect(gradle).toContain("compose-compiler-gradle-plugin");
    expect(gradle).toContain(
      'apply plugin: "org.jetbrains.kotlin.plugin.compose"',
    );
    expect(unguarded).not.toMatch(/compose/iu);
    const script = read("android/src/sandbox/hot-updater-sandbox.gradle");
    expect(script).toContain("android.buildFeatures.compose = true");
    expect(script).toMatch(
      /implementation "androidx\.compose\.foundation:foundation:/u,
    );
    // No Material library: the design draws its own components.
    expect(script).not.toMatch(/material/iu);
    expect(
      fs.readdirSync(path.join(SDK, "android/src/sandbox/res/font")),
    ).toContain("hot_updater_sandbox_geist_regular.ttf");
    expect(fs.existsSync(path.join(SDK, "android/src/main/res/font"))).toBe(
      false,
    );
    // iOS has no resources to ship: the fonts are bytes in a sandbox source.
    const podspec = read("HotUpdater.podspec");
    expect(podspec).not.toMatch(/\.resources?\b|resource_bundles/u);
    const fonts = read(`${IOS_SANDBOX}/HotUpdaterSandboxFonts.swift`);
    expect(fonts).toContain("CTFontManagerRegisterGraphicsFont");
    // The fonts' license goes wherever they go: in the same source, and in the res
    // only a sandbox build attaches.
    expect(fonts).toContain("SIL OPEN FONT LICENSE Version 1.1");
    expect(
      read("android/src/sandbox/res/raw/hot_updater_sandbox_geist_ofl.txt"),
    ).toContain("SIL OPEN FONT LICENSE Version 1.1");
  });

  it("replaces HotUpdaterImpl only through what the generator reads", () => {
    const script = read("android/src/sandbox/hot-updater-sandbox.gradle");
    const generator = read(
      "android/src/sandbox/HotUpdaterSandboxImplGenerator.groovy",
    );
    const impl = read("android/src/main/java/com/hotupdater/HotUpdaterImpl.kt");
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
      "    fun getBaseURL(): String? {",
      "    fun getBundleId(): String? {",
      "    fun getManifest(): Map<String, Any?> {",
    ]) {
      expect(generator, line).toContain(line.trim());
      expect(
        impl.split("\n").filter((text) => text === line),
        line,
      ).toHaveLength(1);
    }
    // A stored session answers each of the three getters before its first
    // statement: the bundle ID reads the selection, the base URL and manifest
    // the running bundle.
    for (const [selection, getters] of [
      ["currentLaunchSelection", 1],
      ["runningLaunchSelection", 2],
    ] as const) {
      expect(generator).toContain(`"val launchSelection = ${selection}"`);
      expect(
        impl
          .split("\n")
          .filter(
            (text) => text === `        val launchSelection = ${selection}`,
          ),
      ).toHaveLength(getters);
    }
    // Its insertions hold for main only.
    expect(generator).toContain(
      "if (environment.isMain) HotUpdaterSandboxDev.bundleOfThisProcess(context)",
    );
    expect(generator).toContain(
      "HotUpdaterSandboxDev.storedBundle(context, environment)",
    );
    expect(
      read("android/src/sandbox/java/com/hotupdater/HotUpdaterSandboxDev.kt"),
    ).toContain("environment?.isMain == true");
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
    expect(impl).toContain(
      "@objcMembers public class HotUpdaterImpl: NSObject",
    );
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
    expect(bridge).toContain(
      "[HotUpdaterNativeUpdates() resetChannelWithImpl:",
    );
    expect(bridge).toContain(
      "[HotUpdaterNativeUpdates() resetChannelIfSelectionCurrentWithImpl:",
    );
  });

  it("gives a session's JavaScript a channel without releases, the same on both platforms", () => {
    const dev = read(
      "android/src/sandbox/java/com/hotupdater/HotUpdaterSandboxDev.kt",
    );
    const override = read(
      "ios/HotUpdater/Sandbox/HotUpdaterSandboxDevOverride.m",
    );
    const channel = "hot-updater-sandbox-dev-server";
    expect(dev).toContain(`DEV_CHANNEL = "${channel}"`);
    expect(override).toContain(`kDevChannel = @"${channel}"`);
    const stored = "hot-updater-sandbox-stored-bundle";
    expect(dev).toContain(`STORED_CHANNEL = "${stored}"`);
    expect(override).toContain(`kStoredChannel = @"${stored}"`);
  });

  it("stores bundles only where the store app's container can't hold them", () => {
    // iOS: only a sandbox with its own bundle ID, in the caches directory.
    const host = read("ios/HotUpdater/Sandbox/HotUpdaterSandboxLiveHost.swift");
    expect(host).toContain(
      'Bundle.main.bundleIdentifier?.hasSuffix(".sandbox") == true',
    );
    expect(host).toContain("for: .cachesDirectory");
    // Android: always the `.sandbox` app's own cache directory.
    expect(
      read("android/src/sandbox/java/com/hotupdater/HotUpdaterSandboxDev.kt"),
    ).toContain('File(app.cacheDir, "hot-updater-sandbox-bundles")');
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
      expect(source, file).not.toContain(SANDBOX_CONDITION);
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
