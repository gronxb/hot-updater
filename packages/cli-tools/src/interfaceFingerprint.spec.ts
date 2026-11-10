import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  autolinkingConfigCommand,
  createInterfaceFingerprint,
  INTERFACE_FINGERPRINT_ENGINE,
  isCodegenSpecFile,
  type NativeInterface,
  reactNativeConfigCommand,
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

  it("hashes text files the same with the CRLF line endings a Windows checkout writes", async () => {
    await fs.rm(path.join(root, "packages/local-module/src"), {
      recursive: true,
    });
    await write(
      path.join(root, "packages/local-module/package.json"),
      manifest({ name: "local-module", version: "1.0.0" }),
    );
    const files = {
      [path.join(app, "src/specs/NativeDevice.ts")]:
        "export interface Spec {\n  getModel(): string;\n}\n",
      [path.join(root, "packages/local-module/ios/Local.swift")]:
        "final class Local {\n  func ping() {}\n}\n",
    };
    for (const [file, contents] of Object.entries(files)) {
      await write(file, contents);
    }
    const lf = await createInterfaceFingerprint(
      app,
      { platform: "ios" },
      nativeInterface(),
    );
    for (const [file, contents] of Object.entries(files)) {
      await write(file, contents.replaceAll("\n", "\r\n"));
    }

    expect(
      await createInterfaceFingerprint(
        app,
        { platform: "ios" },
        nativeInterface(),
      ),
    ).toEqual(lf);
  });

  it("hashes a binary file's bytes as they are", async () => {
    const image = path.join(app, "assets/icon.png");
    await fs.mkdir(path.dirname(image), { recursive: true });
    await fs.writeFile(image, Buffer.from([0x89, 0x50, 0x00, 0x0d, 0x0a]));
    const before = await hashOf({ extraSources: ["assets/icon.png"] });
    await fs.writeFile(image, Buffer.from([0x89, 0x50, 0x00, 0x0a]));

    expect(await hashOf({ extraSources: ["assets/icon.png"] })).not.toBe(
      before,
    );
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
      autolinking: { reactNative: config, expoModules: null },
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

  it("names the iOS platform by the expo-modules-autolinking version", async () => {
    await write(
      path.join(root, "node_modules/expo/package.json"),
      manifest({ name: "expo", version: "50.0.0" }),
    );
    await write(
      path.join(root, "node_modules/expo-modules-autolinking/package.json"),
      manifest({ name: "expo-modules-autolinking", version: "1.9.0" }),
    );
    const resolved = {
      modules: [{ packageName: "expo-old", packageVersion: "1.0.0" }],
    };
    // Before 1.10, expo-modules-autolinking names the iOS platform `ios`.
    await write(
      path.join(
        root,
        "node_modules/expo-modules-autolinking/bin/expo-modules-autolinking.js",
      ),
      `if (process.argv.includes("ios")) console.log(${JSON.stringify(JSON.stringify(resolved))}); else process.exit(1);`,
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

    expect(dependencies).toContainEqual({ name: "expo-old", version: "1.0.0" });
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

  it("hashes a local Expo module's registration and its prebuilt AARs", async () => {
    await fs.rm(path.join(root, "packages/local-module/src"), {
      recursive: true,
    });
    await write(
      path.join(root, "packages/local-module/package.json"),
      manifest({ name: "local-module", version: "1.0.0" }),
    );
    await write(
      path.join(root, "packages/local-module/expo-module.config.json"),
      JSON.stringify({ android: { modules: ["expo.local.FirstModule"] } }),
    );
    await write(path.join(root, "packages/local-module/libs/local.aar"), "v1");
    const native: NativeInterface = {
      runtime: "react-native@0.85.2",
      dependencies: [
        {
          name: "local-module",
          root: path.join(root, "packages/local-module"),
          sourceDirs: [],
          files: [path.join(root, "packages/local-module/libs/local.aar")],
        },
      ],
    };
    const before = await hashOf({ platform: "android" }, native);
    const iosBefore = await hashOf({ platform: "ios" }, native);

    await write(
      path.join(root, "packages/local-module/expo-module.config.json"),
      JSON.stringify({ android: { modules: ["expo.local.SecondModule"] } }),
    );
    const registered = await hashOf({ platform: "android" }, native);
    expect(registered).not.toBe(before);
    // The Android section leaves the iOS fingerprint alone, and so do
    // non-native sections.
    expect(await hashOf({ platform: "ios" }, native)).toBe(iosBefore);
    await write(
      path.join(root, "packages/local-module/expo-module.config.json"),
      JSON.stringify({
        platforms: ["android", "web"],
        android: { modules: ["expo.local.SecondModule"] },
        web: { modules: ["Web"] },
        devtools: { webpageRoot: "dist" },
      }),
    );
    const withWeb = await hashOf({ platform: "android" }, native);
    await write(
      path.join(root, "packages/local-module/expo-module.config.json"),
      JSON.stringify({
        platforms: ["android"],
        android: { modules: ["expo.local.SecondModule"] },
      }),
    );
    const androidOnly = await hashOf({ platform: "android" }, native);
    expect(androidOnly).toBe(withWeb);

    await write(path.join(root, "packages/local-module/libs/local.aar"), "v2");
    expect(await hashOf({ platform: "android" }, native)).not.toBe(androidOnly);
  });

  it("hashes a local Expo module's registration even when it has codegen specs", async () => {
    await write(
      path.join(root, "packages/local-module/expo-module.config.json"),
      JSON.stringify({ apple: { modules: ["FirstModule"] } }),
    );
    const native: NativeInterface = {
      runtime: "react-native@0.85.2",
      dependencies: [
        {
          name: "local-module",
          root: path.join(root, "packages/local-module"),
        },
      ],
    };
    const before = await hashOf({ platform: "ios" }, native);

    await write(
      path.join(root, "packages/local-module/expo-module.config.json"),
      JSON.stringify({ apple: { modules: ["SecondModule"] } }),
    );
    expect(await hashOf({ platform: "ios" }, native)).not.toBe(before);
  });

  it("reads an Expo module's legacy ios registration only without apple", async () => {
    await write(
      path.join(root, "packages/local-module/expo-module.config.json"),
      JSON.stringify({
        apple: { modules: ["Apple"] },
        ios: { modules: ["Old"] },
      }),
    );
    const native: NativeInterface = {
      runtime: "react-native@0.85.2",
      dependencies: [
        {
          name: "local-module",
          root: path.join(root, "packages/local-module"),
        },
      ],
    };
    const before = await hashOf({ platform: "ios" }, native);

    await write(
      path.join(root, "packages/local-module/expo-module.config.json"),
      JSON.stringify({
        apple: { modules: ["Apple"] },
        ios: { modules: ["Older"] },
      }),
    );
    expect(await hashOf({ platform: "ios" }, native)).toBe(before);
  });

  it("reads a legacy Expo module's unimodule.json registration", async () => {
    await write(
      path.join(root, "packages/local-module/unimodule.json"),
      JSON.stringify({ android: { modules: ["First"] } }),
    );
    const native: NativeInterface = {
      runtime: "react-native@0.85.2",
      dependencies: [
        {
          name: "local-module",
          root: path.join(root, "packages/local-module"),
        },
      ],
    };
    const before = await hashOf({ platform: "android" }, native);

    await write(
      path.join(root, "packages/local-module/unimodule.json"),
      JSON.stringify({ android: { modules: ["Second"] } }),
    );
    expect(await hashOf({ platform: "android" }, native)).not.toBe(before);
  });

  it("ignores the key order of an Expo module's registration", async () => {
    const native: NativeInterface = {
      runtime: "react-native@0.85.2",
      dependencies: [
        {
          name: "local-module",
          root: path.join(root, "packages/local-module"),
        },
      ],
    };
    const register = (android: object) =>
      write(
        path.join(root, "packages/local-module/expo-module.config.json"),
        JSON.stringify({ android }),
      );
    await register({ modules: ["A"], publication: { groupId: "g" } });
    const before = await hashOf({ platform: "android" }, native);

    await register({ publication: { groupId: "g" }, modules: ["A"] });
    expect(await hashOf({ platform: "android" }, native)).toBe(before);
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

  it("reads the engine settings the project declares, never an install's lockfile", async () => {
    // pod install records the Hermes pod here, but the file only exists
    // after an install, so it never counts.
    await write(
      path.join(root, "ios/Podfile.lock"),
      "PODS:\n  - hermes-engine (250829098.0.10):\n",
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
    const read = (
      platform: "ios" | "android",
      settings?: Record<string, string>,
    ) =>
      readReactNativeInterface({
        cwd: root,
        command: process.execPath,
        args: ["-e", "console.log('{}')"],
        platform,
        ...(settings ? { settings } : {}),
      });

    expect((await read("ios")).settings).toEqual({});
    expect((await read("android")).settings).toEqual({
      "android:newArchEnabled": "",
      "android:hermesEnabled": "true",
      "android:react.hermesV1Enabled": "false",
      "android:hermesV1Enabled": "true",
    });
    // Settings a framework records elsewhere replace the native projects'.
    expect(
      (await read("android", { "expo.jsEngine": "jsc" })).settings,
    ).toEqual({
      "expo.jsEngine": "jsc",
    });
  });
});

describe("reactNativeConfigCommand", () => {
  let project: string;

  const writeManifest = async (name: string, version: string) => {
    const dir = path.join(project, "node_modules", name);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({ name, version }),
    );
  };

  beforeEach(async () => {
    project = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "hot-updater-expo-fp-")),
    );
    await writeManifest("react-native", "0.76.0");
    await writeManifest("expo", "52.0.0");
  });

  afterEach(async () => {
    await fs.rm(project, { recursive: true, force: true });
  });

  const reactNativeCli = () => [
    path.join(project, "node_modules/react-native/cli.js"),
    "config",
  ];

  it("lists React Native packages with Expo's autolinking from 1.12", async () => {
    await writeManifest("expo-modules-autolinking", "2.0.8");

    expect(reactNativeConfigCommand(project, "ios", {})).toEqual([
      path.join(
        project,
        "node_modules/expo-modules-autolinking/bin/expo-modules-autolinking.js",
      ),
      "react-native-config",
      "--platform",
      "ios",
      "--json",
    ]);
  });

  it("uses React Native CLI before 1.12, such as SDK 50", async () => {
    await writeManifest("expo-modules-autolinking", "1.10.3");

    expect(reactNativeConfigCommand(project, "ios", {})).toEqual(
      reactNativeCli(),
    );
  });

  it("uses React Native CLI when EXPO_USE_COMMUNITY_AUTOLINKING=1", async () => {
    await writeManifest("expo-modules-autolinking", "2.0.8");

    expect(
      reactNativeConfigCommand(project, "ios", {
        EXPO_USE_COMMUNITY_AUTOLINKING: "1",
      }),
    ).toEqual(reactNativeCli());
  });
});

describe("autolinkingConfigCommand", () => {
  let project: string;

  beforeEach(async () => {
    project = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "hot-updater-autolinking-")),
    );
    for (const [name, version] of [
      ["react-native", "0.85.0"],
      ["expo", "54.0.0"],
      ["expo-modules-autolinking", "3.0.0"],
    ]) {
      const dir = path.join(project, "node_modules", name!);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        path.join(dir, "package.json"),
        JSON.stringify({ name, version }),
      );
    }
  });

  afterEach(async () => {
    await fs.rm(project, { recursive: true, force: true });
  });

  it("runs what each build adapter's native project runs", () => {
    expect(
      autolinkingConfigCommand(project, "android", { buildAdapter: "rock" }),
    ).toEqual({ command: "npx", args: ["rock", "config", "-p", "android"] });
    expect(
      autolinkingConfigCommand(project, "ios", { buildAdapter: "bare" }),
    ).toEqual({
      command: process.execPath,
      args: [path.join(project, "node_modules/react-native/cli.js"), "config"],
    });
    expect(
      autolinkingConfigCommand(project, "ios", {
        buildAdapter: "expo",
        env: {},
      }),
    ).toEqual({
      command: process.execPath,
      args: [
        path.join(
          project,
          "node_modules/expo-modules-autolinking/bin/expo-modules-autolinking.js",
        ),
        "react-native-config",
        "--platform",
        "ios",
        "--json",
      ],
    });
  });
});

describe("local native modules", () => {
  const expoModule = async (
    dir: string,
    { packageJson }: { packageJson?: Record<string, unknown> } = {},
  ) => {
    await write(
      path.join(dir, "expo-module.config.json"),
      JSON.stringify({
        platforms: ["apple", "android"],
        apple: { modules: ["LocalModule"] },
        android: { modules: ["expo.local.LocalModule"] },
      }),
    );
    await write(path.join(dir, "ios/Local.podspec"), "Pod::Spec.new");
    await write(
      path.join(dir, "ios/LocalModule.swift"),
      'Function("hello") { "ios" }',
    );
    await write(path.join(dir, "android/build.gradle"), "apply plugin");
    await write(
      path.join(dir, "android/src/main/java/LocalModule.kt"),
      'Function("hello") { "android" }',
    );
    if (packageJson) {
      await write(path.join(dir, "package.json"), manifest(packageJson));
    }
  };

  /** A module as `expo-modules-autolinking resolve` prints it. */
  const resolved = (dir: string, packageName: string, packageVersion = "") => ({
    ios: {
      packageName,
      packageVersion,
      pods: [{ podspecDir: path.join(dir, "ios") }],
    },
    android: {
      packageName,
      packageVersion,
      projects: [{ sourceDir: path.join(dir, "android") }],
    },
  });

  /** Runs the real reader over what autolinking prints for this platform. */
  const readInterface = async (
    platform: "ios" | "android",
    {
      modules = [],
      dependencies = {},
      expoDependencies = {},
      expoConfigFails = false,
      settings,
    }: {
      modules?: ReturnType<typeof resolved>[];
      dependencies?: Record<string, unknown>;
      /** What Expo's `react-native-config` prints beyond React Native CLI. */
      expoDependencies?: Record<string, unknown>;
      expoConfigFails?: boolean;
      settings?: Record<string, string>;
    },
    cwd: string,
  ) => {
    const output = {
      modules: modules.map((module) => module[platform]),
      dependencies: expoDependencies,
    };
    await write(
      path.join(root, "node_modules/expo/package.json"),
      manifest({ name: "expo", version: "57.0.0" }),
    );
    await write(
      path.join(root, "node_modules/expo-modules-autolinking/package.json"),
      manifest({ name: "expo-modules-autolinking", version: "57.0.0" }),
    );
    await write(
      path.join(
        root,
        "node_modules/expo-modules-autolinking/bin/expo-modules-autolinking.js",
      ),
      `${expoConfigFails ? 'if (process.argv.includes("react-native-config")) process.exit(1);' : ""}console.log(${JSON.stringify(JSON.stringify(output))});`,
    );
    const config = {
      dependencies: {
        ...(modules.length > 0
          ? {
              expo: {
                name: "expo",
                root: path.join(root, "node_modules/expo"),
                platforms: { ios: {}, android: {} },
              },
            }
          : {}),
        ...dependencies,
      },
    };
    return readReactNativeInterface({
      cwd,
      command: process.execPath,
      args: ["-e", `console.log(${JSON.stringify(JSON.stringify(config))})`],
      platform,
      ...(settings ? { settings } : {}),
    });
  };

  type Linked = Parameters<typeof readInterface>[1];

  const fingerprint = async (
    platform: "ios" | "android",
    linked: Linked,
    cwd: string = app,
  ) =>
    createInterfaceFingerprint(
      cwd,
      { platform },
      await readInterface(platform, linked, cwd),
    );

  const hashes = async (linked: Linked) => ({
    ios: (await fingerprint("ios", linked)).hash,
    android: (await fingerprint("android", linked)).hash,
  });

  const fileSources = async (platform: "ios" | "android", linked: Linked) =>
    (await fingerprint(platform, linked)).sources.flatMap((source) =>
      source.type === "file" ? [source.filePath] : [],
    );

  const contentIds = async (platform: "ios" | "android", linked: Linked) =>
    (await fingerprint(platform, linked)).sources.flatMap((source) =>
      source.type === "contents" ? [source.id] : [],
    );

  describe.each([
    ["an Expo app", { settings: { "expo.jsEngine": "hermes" } }],
    ["a bare app with Expo modules", {}],
  ])("a stock local Expo module without package.json on %s", (_, host) => {
    const dir = () => path.join(app, "modules/my-module");
    const linked = (): Linked => ({
      ...host,
      modules: [resolved(dir(), "my-module")],
    });

    it("hashes its native files and registration, not `name@`", async () => {
      await expoModule(dir());

      expect(await fileSources("ios", linked())).toEqual(
        expect.arrayContaining([
          "modules/my-module/ios/Local.podspec",
          "modules/my-module/ios/LocalModule.swift",
        ]),
      );
      expect(await fileSources("android", linked())).toEqual(
        expect.arrayContaining([
          "modules/my-module/android/build.gradle",
          "modules/my-module/android/src/main/java/LocalModule.kt",
        ]),
      );
      const ids = await contentIds("ios", linked());
      expect(ids).toContain("expo-module-config:my-module");
      expect(ids).not.toContain("dependency:my-module");
    });

    it("moves only the fingerprint of the platform whose source changed", async () => {
      await expoModule(dir());
      const before = await hashes(linked());

      await write(
        path.join(dir(), "ios/LocalModule.swift"),
        'Function("renamed") { "ios" }',
      );
      const iosRenamed = await hashes(linked());
      expect(iosRenamed.ios).not.toBe(before.ios);
      expect(iosRenamed.android).toBe(before.android);

      await write(
        path.join(dir(), "android/src/main/java/LocalModule.kt"),
        'Function("hello") { "edited body" }',
      );
      const androidEdited = await hashes(linked());
      expect(androidEdited.ios).toBe(iosRenamed.ios);
      expect(androidEdited.android).not.toBe(iosRenamed.android);

      await write(
        path.join(dir(), "expo-module.config.json"),
        JSON.stringify({
          platforms: ["apple", "android"],
          apple: { modules: ["LocalModule"] },
          android: { modules: ["expo.local.OtherModule"] },
        }),
      );
      const registered = await hashes(linked());
      expect(registered.ios).toBe(androidEdited.ios);
      expect(registered.android).not.toBe(androidEdited.android);
    });

    it("ignores what builds and installs write inside it", async () => {
      await expoModule(dir());
      const before = await hashes(linked());

      for (const file of [
        "android/build/generated/Gen.kt",
        "android/.gradle/cache.kts",
        "android/.cxx/Gen.cpp",
        "ios/build/Gen.swift",
        "ios/Pods/Gen.swift",
        "ios/DerivedData/Gen.swift",
        "node_modules/dep/ios/Dep.swift",
        "node_modules/dep/android/Dep.kt",
        "ios/Tests/LocalModuleTests.swift",
        "android/src/androidTest/LocalTest.kt",
      ]) {
        await write(path.join(dir(), file), "generated");
      }

      expect(await hashes(linked())).toEqual(before);
    });

    it("hashes what the same module hashes once it has a package.json", async () => {
      await expoModule(dir());
      const without = await fingerprint("ios", linked());

      await write(
        path.join(dir(), "package.json"),
        manifest({ name: "my-module", version: "1.0.0" }),
      );
      const withManifest = await fingerprint("ios", {
        ...host,
        modules: [resolved(dir(), "my-module", "1.0.0")],
      });

      expect(withManifest.sources).toEqual(without.sources);
      expect(withManifest.hash).toBe(without.hash);
    });
  });

  it("is the same in any checkout, with its files in order", async () => {
    const checkout = async (base: string) => {
      const dir = path.join(base, "shared/my-module");
      await expoModule(dir);
      await write(path.join(dir, "ios/Z.swift"), "final class Z {}");
      await write(path.join(dir, "ios/A.swift"), "final class A {}");
      await write(path.join(base, "app/package.json"), manifest({ name: "a" }));
      return fingerprint(
        "ios",
        { modules: [resolved(dir, "my-module")] },
        path.join(base, "app"),
      );
    };

    const here = await checkout(path.join(root, "one"));
    const there = await checkout(path.join(root, "two/deeper"));

    expect(there).toEqual(here);
    const files = here.sources.flatMap((source) =>
      source.type === "file" ? [source.filePath] : [],
    );
    expect(files).toEqual([
      "../shared/my-module/ios/A.swift",
      "../shared/my-module/ios/Local.podspec",
      "../shared/my-module/ios/LocalModule.swift",
      "../shared/my-module/ios/Z.swift",
    ]);
  });

  it.each([
    ["SDK 52's unversioned shape", "my-module", "UNVERSIONED"],
    ["a scoped folder", "@scope/my-module", ""],
    ["a lowercased mixed-case folder", "my-module", ""],
  ])("tracks %s", async (_, packageName, packageVersion) => {
    const dir = path.join(app, "modules", packageName);
    await expoModule(dir);
    const linked: Linked = {
      modules: [resolved(dir, packageName, packageVersion)],
    };
    const before = await fingerprint("ios", linked);
    expect(await contentIds("ios", linked)).not.toContain(
      `dependency:${packageName}`,
    );

    await write(path.join(dir, "ios/LocalModule.swift"), "renamed");
    expect((await fingerprint("ios", linked)).hash).not.toBe(before.hash);
  });

  it("tracks a module in a monorepo sibling folder by a relative path", async () => {
    const dir = path.join(root, "shared/my-module");
    await expoModule(dir);
    const linked: Linked = { modules: [resolved(dir, "my-module")] };

    expect(await fileSources("ios", linked)).toContain(
      "../shared/my-module/ios/LocalModule.swift",
    );
    const before = await hashes(linked);
    await write(path.join(dir, "ios/LocalModule.swift"), "renamed");
    expect((await hashes(linked)).ios).not.toBe(before.ios);
  });

  it("tracks a local module whose package.json has no name", async () => {
    // Expo 57 and 58 print `packageName: ""` for it, and still link it.
    const dir = path.join(app, "modules/my-module");
    await expoModule(dir, { packageJson: { version: "1.0.0" } });
    const linked: Linked = { modules: [resolved(dir, "", "1.0.0")] };

    expect(await contentIds("ios", linked)).toContain(
      "expo-module-config:my-module",
    );
    const before = await fingerprint("ios", linked);
    await write(path.join(dir, "ios/LocalModule.swift"), "renamed");
    expect((await fingerprint("ios", linked)).hash).not.toBe(before.hash);
  });

  it("tracks a local module whose package.json names something else", async () => {
    const dir = path.join(app, "modules/my-module");
    await expoModule(dir, { packageJson: { name: "other", version: "1.0.0" } });
    const linked: Linked = { modules: [resolved(dir, "my-module", "1.0.0")] };
    const before = await fingerprint("ios", linked);

    await write(path.join(dir, "ios/LocalModule.swift"), "renamed");
    expect((await fingerprint("ios", linked)).hash).not.toBe(before.hash);
  });

  it("reads a module named like its app from the module's folder", async () => {
    await write(path.join(app, "package.json"), manifest({ name: "my-app" }));
    const dir = path.join(app, "modules/my-app");
    await expoModule(dir);
    const linked: Linked = { modules: [resolved(dir, "my-app")] };
    const before = await hashes(linked);

    // The app's own folders stay out of the hash.
    await write(path.join(app, "ios/AppDelegate.swift"), "hand written");
    await write(path.join(app, "android/app/Main.kt"), "hand written");
    expect(await hashes(linked)).toEqual(before);

    await write(
      path.join(dir, "expo-module.config.json"),
      JSON.stringify({ apple: { modules: ["OtherModule"] } }),
    );
    expect((await hashes(linked)).ios).not.toBe(before.ios);
  });

  it("keeps a module installed in node_modules by name and version", async () => {
    const installed = path.join(app, "node_modules/expo-font");
    await expoModule(installed, {
      packageJson: { name: "expo-font", version: "13.3.2" },
    });
    // An alias: autolinking's name matches no package.json above the module.
    const aliased = path.join(app, "node_modules/font-alias");
    await expoModule(aliased, {
      packageJson: { name: "expo-other", version: "2.0.0" },
    });
    const nameless = path.join(app, "node_modules/nameless");
    await expoModule(nameless, { packageJson: { version: "3.0.0" } });
    const linked: Linked = {
      modules: [
        resolved(installed, "expo-font", "13.3.2"),
        resolved(aliased, "font-alias", "2.0.0"),
        resolved(nameless, "", "3.0.0"),
      ],
    };

    expect(
      (await fingerprint("ios", linked)).sources.flatMap((source) =>
        source.type === "contents" && source.id.startsWith("dependency:")
          ? [`${source.id}=${String(source.contents)}`]
          : [],
      ),
    ).toEqual([
      "dependency:expo=expo@57.0.0",
      "dependency:expo-font=expo-font@13.3.2",
      "dependency:font-alias=font-alias@2.0.0",
    ]);
    expect(await fileSources("ios", linked)).toEqual([
      "src/specs/NativeDevice.ts",
    ]);
  });

  describe("linked through react-native.config.js", () => {
    const rnPackage = async (
      dir: string,
      { packageJson }: { packageJson?: Record<string, unknown> } = {},
    ) => {
      await write(path.join(dir, "local.podspec"), "Pod::Spec.new");
      await write(path.join(dir, "ios/Local.m"), "RCT_EXPORT_METHOD(hello)");
      await write(path.join(dir, "android/build.gradle"), "apply plugin");
      await write(path.join(dir, "android/src/Local.kt"), "@ReactMethod hello");
      if (packageJson) {
        await write(path.join(dir, "package.json"), manifest(packageJson));
      }
    };
    const iosOf = (podspecDir: string) => ({
      podspecPath: path.join(podspecDir, "local.podspec"),
    });
    const androidOf = (sourceDir: string) => ({ sourceDir });

    it.each([
      ["with a package.json", { name: "local", version: "1.0.0" }],
      ["without a package.json", undefined],
    ])("tracks a `root` %s", async (_, packageJson) => {
      const dir = path.join(app, "local/local");
      await rnPackage(dir, packageJson ? { packageJson } : {});
      const linked: Linked = {
        dependencies: {
          local: {
            name: "local",
            root: dir,
            platforms: {
              ios: iosOf(dir),
              android: androidOf(path.join(dir, "android")),
            },
          },
        },
      };
      const before = await hashes(linked);

      await write(path.join(dir, "ios/Local.m"), "RCT_EXPORT_METHOD(renamed)");
      const ios = await hashes(linked);
      expect(ios.ios).not.toBe(before.ios);
      expect(ios.android).toBe(before.android);

      await write(
        path.join(dir, "android/src/Local.kt"),
        "@ReactMethod renamed",
      );
      const android = await hashes(linked);
      expect(android.ios).toBe(ios.ios);
      expect(android.android).not.toBe(ios.android);
    });

    it.each([
      ["with a package.json", { name: "local", version: "1.0.0" }],
      ["without a package.json", undefined],
    ])(
      "tracks a `root` %s whose platforms point elsewhere",
      async (_, packageJson) => {
        const dir = path.join(app, "local/local");
        const native = path.join(app, "local/native");
        await write(
          path.join(dir, packageJson ? "package.json" : "README.md"),
          packageJson ? manifest(packageJson) : "docs",
        );
        await rnPackage(native);
        const linked: Linked = {
          dependencies: {
            local: {
              name: "local",
              root: dir,
              platforms: {
                ios: iosOf(native),
                android: androidOf(path.join(native, "android")),
              },
            },
          },
        };
        const before = await hashes(linked);

        await write(
          path.join(native, "ios/Local.m"),
          "RCT_EXPORT_METHOD(renamed)",
        );
        const ios = await hashes(linked);
        expect(ios.ios).not.toBe(before.ios);
        expect(ios.android).toBe(before.android);
      },
    );

    it("tracks platform source paths with no `root`, which React Native CLI prints with no name", async () => {
      const native = path.join(app, "local/native");
      await rnPackage(native);
      const linked: Linked = {
        dependencies: {
          local: {
            platforms: { ios: iosOf(native), android: androidOf(native) },
          },
        },
      };
      expect(await fileSources("ios", linked)).toContain(
        "local/native/ios/Local.m",
      );
      const before = await hashes(linked);

      await write(
        path.join(native, "ios/Local.m"),
        "RCT_EXPORT_METHOD(renamed)",
      );
      expect((await hashes(linked)).ios).not.toBe(before.ios);
    });

    it("leaves out platform source paths in node_modules or nowhere, with no `root`", async () => {
      const installed = path.join(app, "node_modules/hoisted");
      await rnPackage(installed);
      const linked: Linked = {
        dependencies: {
          hoisted: { platforms: { ios: iosOf(installed) } },
          gone: { platforms: { ios: iosOf(path.join(app, "gone")) } },
        },
      };

      expect(await contentIds("ios", linked)).toEqual([
        "codegen-config:.",
        "runtime",
      ]);
    });

    it("hashes a package with a codegen spec by its spec, not its native files", async () => {
      const dir = path.join(app, "local/spec");
      await rnPackage(dir, {
        packageJson: {
          name: "spec",
          version: "1.0.0",
          codegenConfig: { jsSrcsDir: "src" },
        },
      });
      await write(
        path.join(dir, "src/NativeSpec.ts"),
        "export interface Spec { hello(): void }",
      );
      const linked: Linked = {
        dependencies: {
          spec: {
            name: "spec",
            root: dir,
            platforms: { ios: iosOf(dir) },
          },
        },
      };
      const before = await hashes(linked);

      await write(path.join(dir, "ios/Local.m"), "RCT_EXPORT_METHOD(body)");
      expect((await hashes(linked)).ios).toBe(before.ios);

      await write(
        path.join(dir, "src/NativeSpec.ts"),
        "export interface Spec { renamed(): void }",
      );
      expect((await hashes(linked)).ios).not.toBe(before.ios);
    });
  });

  describe("on a bare app whose native project links through Expo's react-native-config", () => {
    const dir = () => path.join(app, "modules/rn-package");
    const native = () => ({
      platforms: {
        ios: { podspecPath: path.join(dir(), "rn.podspec") },
        android: { sourceDir: path.join(dir(), "android") },
      },
    });
    const expoModule_ = () => resolved(path.join(app, "modules/any"), "any");
    const write_ = async () => {
      await expoModule(path.join(app, "modules/any"));
      await write(
        path.join(dir(), "package.json"),
        manifest({ name: "rn-package", version: "1.0.0" }),
      );
      await write(path.join(dir(), "rn.podspec"), "Pod::Spec.new");
      await write(path.join(dir(), "ios/Rn.m"), "RCT_EXPORT_METHOD(hello)");
      await write(path.join(dir(), "android/Rn.kt"), "@ReactMethod hello");
    };

    it("tracks a local package only Expo's autolinking finds", async () => {
      await write_();
      const linked: Linked = {
        modules: [expoModule_()],
        expoDependencies: {
          "rn-package": { name: "rn-package", root: dir(), ...native() },
        },
      };
      expect(await fileSources("ios", linked)).toContain(
        "modules/rn-package/ios/Rn.m",
      );
      const before = await hashes(linked);

      await write(path.join(dir(), "ios/Rn.m"), "RCT_EXPORT_METHOD(renamed)");
      const after = await hashes(linked);
      expect(after.ios).not.toBe(before.ios);
      expect(after.android).toBe(before.android);
    });

    it("leaves out what Expo finds in node_modules, and what React Native CLI lists already", async () => {
      await write_();
      const transitive = path.join(app, "node_modules/transitive");
      await write(
        path.join(transitive, "package.json"),
        manifest({ name: "transitive", version: "1.0.0" }),
      );
      const base: Linked = {
        modules: [expoModule_()],
        dependencies: {
          "rn-package": { name: "rn-package", root: dir(), ...native() },
        },
      };
      const expected = await fingerprint("ios", base);

      expect(
        await fingerprint("ios", {
          ...base,
          expoDependencies: {
            transitive: {
              name: "transitive",
              root: transitive,
              platforms: { ios: {}, android: {} },
            },
            "rn-package": { name: "rn-package", root: dir(), ...native() },
          },
        }),
      ).toEqual(expected);
    });

    it("still computes when Expo's react-native-config fails", async () => {
      await write_();
      const base: Linked = { modules: [expoModule_()] };
      const expected = await fingerprint("ios", base);

      expect(
        await fingerprint("ios", { ...base, expoConfigFails: true }),
      ).toEqual(expected);
    });
  });

  describe("installed through package.json", () => {
    const withDependency = async (spec: string) =>
      write(
        path.join(app, "package.json"),
        manifest({
          name: "app",
          codegenConfig: { jsSrcsDir: "src" },
          dependencies: { foo: spec },
        }),
      );
    const fooFiles = async (dir: string) => {
      await write(
        path.join(dir, "package.json"),
        manifest({ name: "foo", version: "1.0.0" }),
      );
      await write(path.join(dir, "foo.podspec"), "Pod::Spec.new");
      await write(path.join(dir, "ios/Foo.m"), "RCT_EXPORT_METHOD(hello)");
      await write(path.join(dir, "android/Foo.kt"), "@ReactMethod hello");
    };
    const rn = (dir: string): Linked => ({
      dependencies: {
        foo: {
          name: "foo",
          root: dir,
          platforms: {
            ios: { podspecPath: path.join(dir, "foo.podspec") },
            android: { sourceDir: path.join(dir, "android") },
          },
        },
      },
    });

    it.each([
      ["link:", "link:../foo"],
      ["workspace:", "workspace:*"],
      ["file: as npm links it", "file:../foo"],
    ])("tracks %s, a symlink to the source folder", async (_, spec) => {
      const source = path.join(root, "foo");
      await fooFiles(source);
      await withDependency(spec);
      await fs.mkdir(path.join(app, "node_modules"), { recursive: true });
      await fs.symlink(source, path.join(app, "node_modules/foo"));
      const linked = rn(path.join(app, "node_modules/foo"));

      expect(await fileSources("ios", linked)).toContain("../foo/ios/Foo.m");
      const before = await hashes(linked);
      await write(path.join(source, "ios/Foo.m"), "renamed");
      const after = await hashes(linked);
      expect(after.ios).not.toBe(before.ios);
      expect(after.android).toBe(before.android);
    });

    it.each([
      ["Yarn or Bun", "node_modules/foo"],
      ["pnpm", "node_modules/.pnpm/foo@file+..+foo/node_modules/foo"],
    ])("tracks a file: folder %s copies into node_modules", async (_, copy) => {
      await fooFiles(path.join(root, "foo"));
      await withDependency("file:../foo");
      const installed = path.join(app, copy);
      await fooFiles(installed);
      const linked = rn(installed);

      const ids = await contentIds("ios", linked);
      expect(ids).not.toContain("dependency:foo");
      expect(await fileSources("ios", linked)).toContain(`${copy}/ios/Foo.m`);
      const before = await hashes(linked);

      await write(path.join(installed, "ios/Foo.m"), "renamed");
      const after = await hashes(linked);
      expect(after.ios).not.toBe(before.ios);
      expect(after.android).toBe(before.android);
    });

    it.each([
      ["a file: tarball", "file:../foo-1.0.0.tgz"],
      ["a registry version", "^1.0.0"],
      ["a git url", "github:someone/foo#abc"],
    ])("keeps %s by name and version", async (_, spec) => {
      await write(path.join(root, "foo-1.0.0.tgz"), "tarball");
      await withDependency(spec);
      const installed = path.join(app, "node_modules/foo");
      await fooFiles(installed);
      const linked = rn(installed);

      expect(await contentIds("ios", linked)).toContain("dependency:foo");
      const before = await hashes(linked);
      await write(path.join(installed, "ios/Foo.m"), "edited");
      expect(await hashes(linked)).toEqual(before);
    });
  });

  it("keeps a project with no untracked local module byte for byte", async () => {
    // Computed by the code before local modules were tracked, on this fixture:
    // the engine name and every other input are part of this hash.
    const registry = path.join(app, "node_modules/expo-font");
    await expoModule(registry, {
      packageJson: { name: "expo-font", version: "13.3.2" },
    });
    const withManifest = path.join(app, "modules/with-manifest");
    await expoModule(withManifest, {
      packageJson: { name: "with-manifest", version: "1.0.0" },
    });
    const rnLocal = path.join(root, "packages/local-module");
    const linked: Linked = {
      settings: { "expo.jsEngine": "hermes" },
      modules: [
        resolved(registry, "expo-font", "13.3.2"),
        resolved(withManifest, "with-manifest", "1.0.0"),
      ],
      dependencies: {
        "local-module": {
          name: "local-module",
          root: rnLocal,
          platforms: { ios: {}, android: {} },
        },
        "react-native-screens": {
          name: "react-native-screens",
          root: path.join(app, "node_modules/react-native-screens"),
          platforms: { ios: {}, android: {} },
        },
      },
    };

    expect(await hashes(linked)).toEqual({
      ios: "6fc37df35ef74be7dcabdfe7c9a2b9abb1cc59e78214a9f6141d5ce40db11fc1",
      android:
        "9b1c6f3807dccb57dfda9c0c54efe879b134ff47bc3a77b3c750114b18e9581a",
    });
  });
});
