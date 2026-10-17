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
    });
  });
});
