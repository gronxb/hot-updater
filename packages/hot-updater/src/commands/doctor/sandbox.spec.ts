import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ConfigResponse } from "@hot-updater/cli-tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let root: string;

vi.mock("@hot-updater/cli-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@hot-updater/cli-tools")>()),
  getCwd: () => root,
}));

import { checkSandboxSchemes } from "./sandbox";

const write = (file: string, contents: string) => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), contents);
};

const config = (
  nativeBuild: Record<string, unknown>,
  adapter = "bare",
): ConfigResponse =>
  ({
    nativeBuild: { ios: {}, android: {}, ...nativeBuild },
    build: async () => ({ name: adapter }),
  }) as unknown as ConfigResponse;

const androidSandbox = {
  android: {
    beta: { packageName: "com.example", variant: "Release", sandbox: true },
  },
};
const iosSandbox = {
  ios: { beta: { bundleIdentifier: "com.example", sandbox: true } },
};

const googleServices = (...packages: string[]) =>
  JSON.stringify({
    client: packages.map((package_name) => ({
      client_info: { android_client_info: { package_name } },
    })),
  });

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-sandbox-"));
  fs.mkdirSync(path.join(root, "android"));
  write("android/gradle.properties", "android.newDsl=false\n");
  vi.stubEnv("USE_FRAMEWORKS", undefined as unknown as string);
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

const codes = async (...args: Parameters<typeof config>) =>
  (await checkSandboxSchemes(config(...args), root)).map(({ code }) => code);

describe("checkSandboxSchemes", () => {
  it("says nothing without a sandbox scheme, whatever the project", async () => {
    write("android/gradle.properties", "android.newDsl=true\n");
    expect(
      await codes({
        android: { release: { packageName: "com.example" } },
      }),
    ).toEqual([]);
  });

  it("reports a missing google-services client under the real application ID", async () => {
    write(
      "android/app/build.gradle",
      `android { defaultConfig { applicationIdSuffix ".base" } }`,
    );
    write("android/app/google-services.json", googleServices("com.example"));

    const issues = await checkSandboxSchemes(config(androidSandbox), root);

    expect(issues).toEqual([
      expect.objectContaining({
        type: "warning",
        code: "SANDBOX_GOOGLE_SERVICES_CLIENT_MISSING",
        message:
          "android/app/google-services.json has no client for com.example.base.sandbox.",
      }),
    ]);
  });

  it("accepts a google-services file with the client, and a project without one", async () => {
    expect(await codes(androidSandbox)).toEqual([]);
    write(
      "android/app/google-services.json",
      googleServices("com.example", "com.example.sandbox"),
    );
    expect(await codes(androidSandbox)).toEqual([]);
  });

  it("reads the variant's own google-services file first", async () => {
    write("android/app/google-services.json", googleServices("com.other"));
    write(
      "android/app/src/release/google-services.json",
      googleServices("com.example.sandbox"),
    );
    expect(await codes(androidSandbox)).toEqual([]);
  });

  it("reports what a build would refuse as errors", async () => {
    write("android/gradle.properties", "android.newDsl=true\n");
    write(
      "ios/App.xcodeproj/project.pbxproj",
      '/* XCLocalSwiftPackageReference "build/generated/autolinking" */',
    );

    const issues = await checkSandboxSchemes(
      config({ ...androidSandbox, ...iosSandbox }),
      root,
    );

    expect(issues.map(({ type, code }) => [type, code])).toEqual([
      ["error", "SANDBOX_BUILD_BLOCKED"],
      ["error", "SANDBOX_BUILD_BLOCKED"],
    ]);
    expect(issues[1]!.message).toBe(
      "beta: Sandbox builds don't support AGP 9's default DSL yet.",
    );
    expect(issues[1]!.resolution).toBe(
      "Set android.newDsl=false in android/gradle.properties.",
    );
  });

  it("warns about the rock adapter", async () => {
    const issues = await checkSandboxSchemes(
      config(androidSandbox, "rock"),
      root,
    );
    expect(issues).toEqual([
      expect.objectContaining({
        type: "warning",
        code: "SANDBOX_UNQUALIFIED",
        message:
          "Sandbox builds aren't tested with the rock build adapter yet.",
      }),
    ]);
  });

  it("takes the Expo SDK sandbox builds ran on, and warns about any other", async () => {
    write(
      "package.json",
      JSON.stringify({ dependencies: { expo: "~52.0.49" } }),
    );
    expect(
      await checkSandboxSchemes(config(androidSandbox, "expo"), root),
    ).toEqual([]);

    write(
      "package.json",
      JSON.stringify({ devDependencies: { expo: "^54.0.0" } }),
    );
    expect(
      await checkSandboxSchemes(config(androidSandbox, "expo"), root),
    ).toEqual([
      expect.objectContaining({
        code: "SANDBOX_UNQUALIFIED",
        message: "Sandbox builds aren't tested with Expo SDK 54 yet.",
      }),
    ]);

    write("package.json", "{}");
    expect(
      await checkSandboxSchemes(config(androidSandbox, "expo"), root),
    ).toEqual([
      expect.objectContaining({
        message: "Sandbox builds aren't tested with this Expo SDK yet.",
      }),
    ]);
  });

  it("warns about use_frameworks and app extensions, but not the template's guarded line", async () => {
    write(
      "ios/Podfile",
      `linkage = ENV['USE_FRAMEWORKS']
if linkage != nil
  use_frameworks! :linkage => linkage.to_sym
end`,
    );
    expect(await codes(iosSandbox)).toEqual([]);

    write("ios/Podfile", "target 'App' do\n  use_frameworks!\nend\n");
    write(
      "ios/App.xcodeproj/project.pbxproj",
      'productType = "com.apple.product-type.app-extension";',
    );
    const issues = await checkSandboxSchemes(config(iosSandbox), root);
    expect(issues.map(({ message }) => message)).toEqual([
      "Sandbox builds aren't tested with use_frameworks yet.",
      "Sandbox builds aren't tested with app extensions yet.",
    ]);
  });
});
