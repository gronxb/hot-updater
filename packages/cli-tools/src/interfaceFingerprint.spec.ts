import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createInterfaceFingerprint,
  INTERFACE_FINGERPRINT_ENGINE,
  isCodegenSpecFile,
  type NativeInterface,
  readReactNativeInterface,
} from "./interfaceFingerprint";

let root: string;
let app: string;

const write = async (file: string, contents: string) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, contents);
};

const manifest = (fields: Record<string, unknown>) => JSON.stringify(fields);

beforeEach(async () => {
  root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "interface-fingerprint-")),
  );
  app = path.join(root, "app");
  await write(
    path.join(app, "package.json"),
    manifest({ name: "app", codegenConfig: { jsSrcsDir: "src" } }),
  );
  await write(
    path.join(app, "src/specs/NativeDevice.ts"),
    "export interface Spec { getModel(): string }",
  );
  await write(path.join(app, "src/App.tsx"), "export const App = 1;");
  await write(
    path.join(app, "node_modules/react-native-screens/package.json"),
    manifest({ name: "react-native-screens", version: "4.25.2" }),
  );
  await write(
    path.join(root, "packages/local-module/package.json"),
    manifest({
      name: "local-module",
      version: "1.0.0",
      codegenConfig: { jsSrcsDir: "src" },
    }),
  );
  await write(
    path.join(root, "packages/local-module/src/NativeLocal.ts"),
    "export interface Spec { ping(): void }",
  );
  await write(
    path.join(root, "packages/local-module/ios/Local.swift"),
    "final class Local {}",
  );
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const nativeInterface = (): NativeInterface => ({
  runtime: "react-native@0.85.2",
  dependencies: [
    {
      name: "react-native-screens",
      root: path.join(app, "node_modules/react-native-screens"),
    },
    { name: "local-module", root: path.join(root, "packages/local-module") },
  ],
});

const hashOf = async (
  options: Partial<Parameters<typeof createInterfaceFingerprint>[1]> = {},
  native: NativeInterface = nativeInterface(),
) =>
  (
    await createInterfaceFingerprint(
      app,
      { platform: "ios", ...options },
      native,
    )
  ).hash;

describe("createInterfaceFingerprint", () => {
  it("lists the runtime, registry packages, and specs with the engine", async () => {
    const fingerprint = await createInterfaceFingerprint(
      app,
      { platform: "ios" },
      nativeInterface(),
    );

    expect(fingerprint.engine).toBe(INTERFACE_FINGERPRINT_ENGINE);
    expect(
      fingerprint.sources.map((source) =>
        source.type === "contents"
          ? `${source.id}=${String(source.contents)}`
          : source.filePath,
      ),
    ).toEqual([
      'codegen-config:.={"jsSrcsDir":"src"}',
      'codegen-config:../packages/local-module={"jsSrcsDir":"src"}',
      "dependency:react-native-screens=react-native-screens@4.25.2",
      "runtime=react-native@0.85.2",
      "../packages/local-module/src/NativeLocal.ts",
      "src/specs/NativeDevice.ts",
    ]);
  });

  it("ignores JavaScript, native implementations, and JavaScript-only patches", async () => {
    const before = await hashOf();
    await write(path.join(app, "src/App.tsx"), "export const App = 2;");
    await write(
      path.join(root, "packages/local-module/ios/Local.swift"),
      "final class Local { func ping() {} }",
    );
    await write(path.join(app, "patches/lodash+4.17.21.patch"), "diff");

    expect(await hashOf()).toBe(before);
  });

  it("changes with a spec, a native package version, a patch, or nativeVersion", async () => {
    const before = await hashOf();

    await write(
      path.join(app, "src/specs/NativeDevice.ts"),
      "export interface Spec { getModel(): string; getBrand(): string }",
    );
    const specChanged = await hashOf();
    expect(specChanged).not.toBe(before);

    await write(
      path.join(root, "packages/local-module/src/NativeLocal.ts"),
      "export interface Spec { ping(): void; pong(): void }",
    );
    const localSpecChanged = await hashOf();
    expect(localSpecChanged).not.toBe(specChanged);

    await write(
      path.join(app, "node_modules/react-native-screens/package.json"),
      manifest({ name: "react-native-screens", version: "4.26.0" }),
    );
    const versionChanged = await hashOf();
    expect(versionChanged).not.toBe(localSpecChanged);

    await write(
      path.join(app, "patches/react-native-screens+4.26.0.patch"),
      "diff",
    );
    const patched = await hashOf();
    expect(patched).not.toBe(versionChanged);

    expect(await hashOf({ nativeVersion: 2 })).not.toBe(patched);
  });

  it("reads patches from the workspace root of a monorepo", async () => {
    await write(path.join(root, "pnpm-workspace.yaml"), "packages: []");
    const before = await hashOf();
    await write(
      path.join(root, "patches/react-native-screens@4.25.2.patch"),
      "diff",
    );

    expect(await hashOf()).not.toBe(before);
  });

  it("reads the specs of a package that lists codegen libraries", async () => {
    await write(
      path.join(root, "packages/local-module/package.json"),
      manifest({
        name: "local-module",
        version: "1.0.0",
        codegenConfig: {
          libraries: [
            { name: "LocalSpec", type: "modules", jsSrcsDir: "src" },
            { name: "LocalViews", type: "components", jsSrcsDir: "views" },
          ],
        },
      }),
    );
    await write(
      path.join(
        root,
        "packages/local-module/views/LocalViewNativeComponent.ts",
      ),
      "export default {};",
    );
    const before = await hashOf();

    await write(
      path.join(root, "packages/local-module/ios/Local.swift"),
      "final class Local { func ping() {} }",
    );
    expect(await hashOf()).toBe(before);

    await write(
      path.join(
        root,
        "packages/local-module/views/LocalViewNativeComponent.ts",
      ),
      "export default { color: 1 };",
    );
    expect(await hashOf()).not.toBe(before);
  });

  it("reads the patch files a package manager records for native packages", async () => {
    await write(path.join(root, "pnpm-workspace.yaml"), "packages: []\n");
    const before = await hashOf();

    await write(path.join(root, "patches/screens-native-fix.patch"), "a");
    await write(path.join(root, "patches/fix-app-js.patch"), "a");
    await write(
      path.join(root, "pnpm-workspace.yaml"),
      [
        "packages: []",
        "patchedDependencies:",
        "  react-native-screens@4.25.2: patches/screens-native-fix.patch",
        "  lodash: patches/fix-app-js.patch",
        "",
      ].join("\n"),
    );
    const patched = await hashOf();
    expect(patched).not.toBe(before);

    await write(path.join(root, "patches/fix-app-js.patch"), "b");
    expect(await hashOf()).toBe(patched);
    await write(path.join(root, "patches/screens-native-fix.patch"), "b");
    expect(await hashOf()).not.toBe(patched);
  });

  it("reads a Yarn patch: resolution", async () => {
    const before = await hashOf();
    await write(path.join(app, ".yarn/patches/screens.patch"), "a");
    await write(
      path.join(app, "package.json"),
      manifest({
        name: "app",
        codegenConfig: { jsSrcsDir: "src" },
        resolutions: {
          "react-native-screens@npm:4.25.2":
            "patch:react-native-screens@npm%3A4.25.2#~/.yarn/patches/screens.patch",
        },
      }),
    );

    expect(await hashOf()).not.toBe(before);
  });

  it("reads a Yarn patch: dependency", async () => {
    const before = await hashOf();
    await write(path.join(app, ".yarn/patches/screens.patch"), "a");
    await write(
      path.join(app, "package.json"),
      manifest({
        name: "app",
        codegenConfig: { jsSrcsDir: "src" },
        dependencies: {
          "react-native-screens":
            "patch:react-native-screens@npm%3A4.25.2#./.yarn/patches/screens.patch::locator=app%40workspace%3A.",
        },
      }),
    );
    const patched = await hashOf();
    expect(patched).not.toBe(before);

    await write(path.join(app, ".yarn/patches/screens.patch"), "b");
    expect(await hashOf()).not.toBe(patched);
  });

  it("changes with the codegen config, not its key order", async () => {
    const before = await hashOf();
    await write(
      path.join(app, "package.json"),
      JSON.stringify({ codegenConfig: { jsSrcsDir: "src" }, name: "app" }),
    );
    expect(await hashOf()).toBe(before);

    await write(
      path.join(root, "packages/local-module/package.json"),
      manifest({
        name: "local-module",
        version: "1.0.0",
        codegenConfig: { jsSrcsDir: "src", type: "all" },
      }),
    );
    expect(await hashOf()).not.toBe(before);
  });

  it("hashes only the platform's own section of the codegen config", async () => {
    const ios = await hashOf();
    const android = await hashOf({ platform: "android" });
    await write(
      path.join(app, "package.json"),
      manifest({
        name: "app",
        codegenConfig: {
          jsSrcsDir: "src",
          android: { javaPackageName: "com.app" },
        },
      }),
    );

    expect(await hashOf()).toBe(ios);
    expect(await hashOf({ platform: "android" })).not.toBe(android);

    // So does each entry's in the deprecated libraries form.
    const libraries = (javaPackageName: string) =>
      write(
        path.join(app, "package.json"),
        manifest({
          name: "app",
          codegenConfig: {
            libraries: [{ jsSrcsDir: "src", android: { javaPackageName } }],
          },
        }),
      );
    await libraries("com.app");
    const iosWithLibraries = await hashOf();
    const androidWithLibraries = await hashOf({ platform: "android" });
    await libraries("com.other");
    expect(await hashOf()).toBe(iosWithLibraries);
    expect(await hashOf({ platform: "android" })).not.toBe(
      androidWithLibraries,
    );
  });

  it("hashes a dependency declared by name and version", async () => {
    const native = (version: string): NativeInterface => ({
      runtime: "lynx@4.0.3",
      dependencies: [{ name: "pod:SDWebImage", version }],
    });

    expect(await hashOf({}, native("5.15.5"))).toBe(
      await hashOf({}, native("5.15.5")),
    );
    expect(await hashOf({}, native("5.16.0"))).not.toBe(
      await hashOf({}, native("5.15.5")),
    );
  });

  it("changes with a native setting", async () => {
    const withSettings = (settings: Record<string, string>) =>
      hashOf({}, { ...nativeInterface(), settings });

    expect(await withSettings({ "android:hermesEnabled": "true" })).toBe(
      await withSettings({ "android:hermesEnabled": "true" }),
    );
    expect(await withSettings({ "android:hermesEnabled": "false" })).not.toBe(
      await withSettings({ "android:hermesEnabled": "true" }),
    );
  });

  it("follows the runtime version", async () => {
    expect(
      await hashOf(
        {},
        { ...nativeInterface(), runtime: "react-native@0.86.0" },
      ),
    ).not.toBe(await hashOf());
  });

  it("hashes a local package without specs by its native files", async () => {
    await fs.rm(path.join(root, "packages/local-module/src"), {
      recursive: true,
    });
    await write(
      path.join(root, "packages/local-module/package.json"),
      manifest({ name: "local-module", version: "1.0.0" }),
    );
    const before = await hashOf();
    await write(
      path.join(root, "packages/local-module/ios/Local.swift"),
      "final class Local { func ping() {} }",
    );

    expect(await hashOf()).not.toBe(before);
  });

  it("hashes a local package's native files for a platform its specs don't cover", async () => {
    await fs.rm(path.join(root, "packages/local-module/src"), {
      recursive: true,
    });
    await write(
      path.join(root, "packages/local-module/src/NativeLocal.android.ts"),
      "export interface Spec { ping(): void }",
    );
    const before = await hashOf();
    await write(
      path.join(root, "packages/local-module/ios/Local.swift"),
      "final class Local { func ping() {} }",
    );

    expect(await hashOf()).not.toBe(before);
  });

  it("hashes a local package's native code where autolinking points", async () => {
    await fs.rm(path.join(root, "packages/local-module/src"), {
      recursive: true,
    });
    await write(
      path.join(root, "packages/local-module/package.json"),
      manifest({ name: "local-module", version: "1.0.0" }),
    );
    await write(
      path.join(root, "packages/local-module/native/android/Local.kt"),
      "class Local",
    );
    const native = (): NativeInterface => ({
      runtime: "react-native@0.85.2",
      dependencies: [
        {
          name: "local-module",
          root: path.join(root, "packages/local-module"),
          sourceDirs: [path.join(root, "packages/local-module/native/android")],
        },
      ],
    });
    const before = await hashOf({ platform: "android" }, native());
    await write(
      path.join(root, "packages/local-module/native/android/Local.kt"),
      "class Local { fun ping() {} }",
    );

    expect(await hashOf({ platform: "android" }, native())).not.toBe(before);
  });

  it("hashes a local package's native code at its root, without a nested package's", async () => {
    await fs.rm(path.join(root, "packages/local-module/src"), {
      recursive: true,
    });
    await write(
      path.join(root, "packages/local-module/package.json"),
      manifest({ name: "local-module", version: "1.0.0" }),
    );
    await write(
      path.join(root, "packages/local-module/local-module.podspec"),
      "Pod::Spec.new",
    );
    await write(
      path.join(root, "packages/local-module/cpp/Local.cxx"),
      "int local() { return 1; }",
    );
    await write(
      path.join(root, "packages/local-module/example/package.json"),
      manifest({ name: "example" }),
    );
    await write(
      path.join(root, "packages/local-module/example/ios/App.swift"),
      "final class App {}",
    );
    const native = (): NativeInterface => ({
      runtime: "react-native@0.85.2",
      dependencies: [
        {
          name: "local-module",
          root: path.join(root, "packages/local-module"),
          sourceDirs: [path.join(root, "packages/local-module")],
        },
      ],
    });
    const before = await hashOf({}, native());

    await write(
      path.join(root, "packages/local-module/example/ios/App.swift"),
      "final class App { func run() {} }",
    );
    expect(await hashOf({}, native())).toBe(before);

    await write(
      path.join(root, "packages/local-module/cpp/Local.cxx"),
      "int local(int x) { return x; }",
    );
    expect(await hashOf({}, native())).not.toBe(before);
  });

  it("hashes the same files when autolinking points at the standard folders", async () => {
    await fs.rm(path.join(root, "packages/local-module/src"), {
      recursive: true,
    });
    await write(
      path.join(root, "packages/local-module/package.json"),
      manifest({ name: "local-module", version: "1.0.0" }),
    );
    await write(
      path.join(root, "packages/local-module/android/src/Local.kt"),
      "class Local",
    );
    const native = (sourceDir?: string): NativeInterface => ({
      runtime: "react-native@0.85.2",
      dependencies: [
        {
          name: "local-module",
          root: path.join(root, "packages/local-module"),
          ...(sourceDir ? { sourceDirs: [sourceDir] } : {}),
        },
      ],
    });

    expect(
      await hashOf(
        { platform: "android" },
        native(path.join(root, "packages/local-module/android")),
      ),
    ).toBe(await hashOf({ platform: "android" }, native()));
  });

  it("applies ignorePaths inside an extraSources directory", async () => {
    await write(path.join(app, "config/native.json"), "{}");
    const options = {
      extraSources: ["config"],
      ignorePaths: ["config/secrets.json"],
    };
    const before = await hashOf(options);
    await write(path.join(app, "config/secrets.json"), "token");

    expect(await hashOf(options)).toBe(before);
  });

  it("leaves a local package's tests out of its native files", async () => {
    await fs.rm(path.join(root, "packages/local-module/src"), {
      recursive: true,
    });
    await write(
      path.join(root, "packages/local-module/android/build.gradle"),
      "android {}",
    );
    const ios = await hashOf();
    const android = await hashOf({ platform: "android" });
    await write(
      path.join(root, "packages/local-module/ios/Tests/LocalTests.swift"),
      "final class LocalTests {}",
    );
    await write(
      path.join(
        root,
        "packages/local-module/android/src/test/java/LocalTest.kt",
      ),
      "class LocalTest",
    );

    expect(await hashOf()).toBe(ios);
    expect(await hashOf({ platform: "android" })).toBe(android);
  });

  it("keeps a platform-specific spec out of the other platform", async () => {
    const android = await hashOf({ platform: "android" });
    await write(path.join(app, "src/specs/NativeDevice.ios.ts"), "export {};");

    expect(await hashOf({ platform: "android" })).toBe(android);
  });

  it("hashes extraSources files and directories", async () => {
    const before = await hashOf({ extraSources: ["config"] });
    await write(path.join(app, "config/native.json"), "{}");

    expect(await hashOf({ extraSources: ["config"] })).not.toBe(before);
  });

  it("keeps an extraSources directory naming the project root inside it", async () => {
    const { sources } = await createInterfaceFingerprint(
      app,
      { platform: "ios", extraSources: ["."] },
      nativeInterface(),
    );
    const extra = sources.flatMap((source) =>
      source.type === "file" && source.reasons?.includes("extra-source")
        ? [source.filePath]
        : [],
    );

    expect(extra.every((filePath) => !filePath.startsWith(".."))).toBe(true);
    expect(extra).toContain("src/App.tsx");
  });
});

describe("isCodegenSpecFile", () => {
  it("follows React Native codegen's spec file rule", () => {
    expect(isCodegenSpecFile("src/NativeDevice.ts", "ios")).toBe(true);
    expect(isCodegenSpecFile("src/SliderNativeComponent.tsx", "ios")).toBe(
      true,
    );
    expect(isCodegenSpecFile("src/NativeDevice.android.ts", "ios")).toBe(false);
    expect(isCodegenSpecFile("src/NativeDevice.d.ts", "ios")).toBe(false);
    expect(isCodegenSpecFile("src/__tests__/NativeDevice.ts", "ios")).toBe(
      false,
    );
    expect(isCodegenSpecFile("src/App.tsx", "ios")).toBe(false);
    expect(isCodegenSpecFile("src/NativeDevice.fb.js", "ios")).toBe(true);
    expect(isCodegenSpecFile("src/NativeDevice.android.fb.js", "ios")).toBe(
      false,
    );
    expect(isCodegenSpecFile("src/NativeDevice.android.fb.js", "android")).toBe(
      true,
    );
  });
});

describe("readReactNativeInterface", () => {
  it("reads the runtime and the packages linked on the platform", async () => {
    await write(
      path.join(root, "rn/package.json"),
      manifest({ name: "react-native", version: "0.85.2" }),
    );
    const config = {
      reactNativePath: path.join(root, "rn"),
      dependencies: {
        both: { name: "both", root: "/both", platforms: { ios: {} } },
        android: {
          name: "android-only",
          root: "/android",
          platforms: { ios: null, android: {} },
        },
      },
    };

    expect(
      await readReactNativeInterface({
        cwd: root,
        command: process.execPath,
        args: [
          "-e",
          `console.log("info: banner"); console.log(${JSON.stringify(JSON.stringify(config))})`,
        ],
        platform: "ios",
      }),
    ).toEqual({
      runtime: "react-native@0.85.2",
      dependencies: [{ name: "both", root: "/both" }],
      settings: {},
    });
  });

  it("adds the Expo modules an app links through expo-modules-autolinking", async () => {
    await write(
      path.join(root, "node_modules/expo/package.json"),
      manifest({ name: "expo", version: "52.0.49" }),
    );
    await write(
      path.join(root, "node_modules/expo-modules-autolinking/package.json"),
      manifest({ name: "expo-modules-autolinking", version: "2.0.8" }),
    );
    await write(
      path.join(root, "node_modules/expo-font/package.json"),
      manifest({ name: "expo-font", version: "13.3.2" }),
    );
    const modules = {
      modules: [
        {
          packageName: "expo-font",
          packageVersion: "13.3.2",
          pods: [{ podspecDir: path.join(root, "node_modules/expo-font/ios") }],
        },
        { packageName: "expo-local", packageVersion: "1.0.0" },
      ],
    };
    await write(
      path.join(
        root,
        "node_modules/expo-modules-autolinking/bin/expo-modules-autolinking.js",
      ),
      `if (process.argv.includes("apple")) console.log(${JSON.stringify(JSON.stringify(modules))}); else process.exit(1);`,
    );
    const config = {
      dependencies: {
        expo: {
          name: "expo",
          root: path.join(root, "node_modules/expo"),
          platforms: { ios: {} },
        },
      },
    };

    const { dependencies } = await readReactNativeInterface({
      cwd: root,
      command: process.execPath,
      args: ["-e", `console.log(${JSON.stringify(JSON.stringify(config))})`],
      platform: "ios",
    });

    expect(dependencies).toEqual([
      { name: "expo", root: path.join(root, "node_modules/expo") },
      {
        name: "expo-font",
        root: path.join(root, "node_modules/expo-font"),
        sourceDirs: [path.join(root, "node_modules/expo-font/ios")],
      },
      { name: "expo-local", version: "1.0.0" },
    ]);
  });

  it("hashes every native folder a local Expo module declares", async () => {
    await fs.rm(path.join(root, "packages/local-module/src"), {
      recursive: true,
    });
    await write(
      path.join(root, "packages/local-module/package.json"),
      manifest({ name: "local-module", version: "1.0.0" }),
    );
    await write(
      path.join(root, "packages/local-module/android/Local.kt"),
      "class Local",
    );
    await write(
      path.join(root, "packages/local-module/extra/android/Extra.kt"),
      "class Extra",
    );
    const native: NativeInterface = {
      runtime: "react-native@0.85.2",
      dependencies: [
        {
          name: "local-module",
          root: path.join(root, "packages/local-module"),
          sourceDirs: [
            path.join(root, "packages/local-module/android"),
            path.join(root, "packages/local-module/extra/android"),
          ],
        },
      ],
    };
    const before = await hashOf({ platform: "android" }, native);

    await write(
      path.join(root, "packages/local-module/extra/android/Extra.kt"),
      "class Extra { fun ping() {} }",
    );
    expect(await hashOf({ platform: "android" }, native)).not.toBe(before);
  });

  it("explains a config command that prints no configuration", async () => {
    await expect(
      readReactNativeInterface({
        cwd: root,
        command: process.execPath,
        args: ["-e", "console.log('install @react-native-community/cli')"],
        platform: "ios",
      }),
    ).rejects.toThrow("printed no JSON configuration");
  });

  it("reads the JavaScript engine React Native resolved for each platform", async () => {
    await write(
      path.join(root, "ios/Podfile.lock"),
      [
        "PODS:",
        "  - hermes-engine (250829098.0.10):",
        "    - hermes-engine/Pre-built (= 250829098.0.10)",
        "  - hermes-engine/Pre-built (250829098.0.10)",
        "",
        "DEPENDENCIES:",
        "  - hermes-engine (from `x`)",
      ].join("\n"),
    );
    await write(
      path.join(root, "android/gradle.properties"),
      [
        "# comment",
        "org.gradle.jvmargs=-Xmx2048m",
        "newArchEnabled",
        "hermesEnabled = true",
        "react.hermesV1Enabled: false",
        "hermesV1Enabled \\",
        "  true",
      ].join("\n"),
    );
    const read = (platform: "ios" | "android") =>
      readReactNativeInterface({
        cwd: root,
        command: process.execPath,
        args: ["-e", "console.log('{}')"],
        platform,
      });

    expect((await read("ios")).settings).toEqual({
      "ios:hermes-engine": "250829098.0.10",
    });
    expect((await read("android")).settings).toEqual({
      "android:newArchEnabled": "",
      "android:hermesEnabled": "true",
      "android:react.hermesV1Enabled": "false",
      "android:hermesV1Enabled": "true",
    });

    await write(
      path.join(root, "ios/Podfile.lock"),
      "PODS:\n  - Yoga (0.0.0)\n",
    );
    expect((await read("ios")).settings).toEqual({
      "ios:hermes-engine": "none",
    });
  });
});
