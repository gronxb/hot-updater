import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let root: string;

vi.mock("@hot-updater/cli-tools", () => ({ getCwd: () => root }));

import {
  findSandboxGradleBlocker,
  sandboxInitScript,
  sandboxManifestOverlay,
  withSandboxGradleArgs,
} from "./sandboxGradle";

const write = (file: string, contents: string) => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), contents);
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-gradle-"));
  fs.mkdirSync(path.join(root, "android"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const scheme = {
  sandbox: true,
  hotUpdaterSchemeName: "release",
  appModuleName: "app",
  variant: "Release",
};

describe("withSandboxGradleArgs", () => {
  it("adds nothing for a normal scheme", async () => {
    const build = vi.fn(async (args: string[]) => args);
    expect(
      await withSandboxGradleArgs({ ...scheme, sandbox: false }, build),
    ).toEqual([]);
  });

  it("names the init script, the SDK's property, and no incremental Kotlin, then removes its files", async () => {
    let written: { script: string; overlay: string } | undefined;
    const args = await withSandboxGradleArgs(scheme, async (gradleArgs) => {
      const script = gradleArgs[gradleArgs.indexOf("--init-script") + 1]!;
      written = {
        script,
        overlay: path.join(path.dirname(script), "AndroidManifest.xml"),
      };
      expect(fs.readFileSync(written.script, "utf-8")).toContain(
        `new File('${written.overlay}')`,
      );
      expect(fs.readFileSync(written.overlay, "utf-8")).toContain(
        'android:value="sandbox-release"',
      );
      return gradleArgs;
    });
    expect(args).toEqual([
      "--init-script",
      written!.script,
      "-PhotUpdaterSandbox=release",
      "-Pkotlin.incremental=false",
    ]);
    // Nothing is left beside the build, and nothing ever in the project.
    expect(written!.script.startsWith(root)).toBe(false);
    expect(fs.existsSync(written!.script)).toBe(false);
    expect(fs.existsSync(written!.overlay)).toBe(false);
  });
});

describe("the files a sandbox build writes", () => {
  it("replaces the app's channel and declares the sandbox", () => {
    const overlay = sandboxManifestOverlay("sandbox-release");
    expect(overlay).toContain(
      '<meta-data android:name="com.hotupdater.CHANNEL" android:value="sandbox-release" tools:replace="android:value" />',
    );
    expect(overlay).toContain(
      '<meta-data android:name="com.hotupdater.SANDBOX" android:value="true" />',
    );
  });

  it("acts on the app module only, after the project's settings, and appends the suffix", () => {
    const script = sandboxInitScript({
      appModuleName: "app",
      variant: "stagingRelease",
      overlay: "/tmp/it's/AndroidManifest.xml",
    });
    expect(script).toContain("def appModule = ':app'");
    expect(script).toContain("def variant = 'stagingrelease'");
    expect(script).toContain("new File('/tmp/it\\'s/AndroidManifest.xml')");
    expect(script).toContain("components.finalizeDsl");
    expect(script).toContain(
      "dsl.defaultConfig.applicationIdSuffix = (dsl.defaultConfig.applicationIdSuffix ?: '') + '.sandbox'",
    );
  });

  it("fails in Gradle on AGP 9's default DSL and on a manifest it would replace", () => {
    const script = sandboxInitScript({
      appModuleName: "app",
      variant: "Release",
      overlay: "/tmp/AndroidManifest.xml",
    });
    expect(script).toContain(
      "components.pluginVersion.major >= 9 && project.findProperty('android.newDsl')?.toString() != 'false'",
    );
    expect(script).toContain("Sandbox builds don\\'t support AGP 9");
    expect(script).toContain("if (own.exists())");
    expect(script).toContain("A sandbox build can\\'t merge with");
  });
});

describe("findSandboxGradleBlocker", () => {
  it("finds nothing in a project it can build", () => {
    write("android/gradle.properties", "android.newDsl=false\n");
    expect(findSandboxGradleBlocker({})).toBeNull();
  });

  it("finds nothing without an android directory, as before a prebuild", () => {
    fs.rmSync(path.join(root, "android"), { recursive: true });
    expect(findSandboxGradleBlocker({})).toBeNull();
  });

  it("refuses android.newDsl=true", () => {
    write("android/gradle.properties", "android.newDsl=true\n");
    expect(findSandboxGradleBlocker({})).toBe(
      "Sandbox builds don't support AGP 9's default DSL yet.\nSet android.newDsl=false in android/gradle.properties.",
    );
  });

  it.each([
    [
      "the project pins",
      'classpath("com.android.tools.build:gradle:9.0.0")',
      null,
    ],
    ["React Native's catalog says", "", 'agp = "9.2.1"'],
  ])(
    "refuses AGP 9 that %s, when the property is unset",
    (_, rootBuild, catalog) => {
      write("android/build.gradle", rootBuild);
      if (catalog) {
        write("node_modules/react-native/package.json", "{}");
        write("node_modules/react-native/gradle/libs.versions.toml", catalog);
      }
      expect(findSandboxGradleBlocker({})).toContain("AGP 9");
    },
  );

  it("allows AGP 8 with the property unset", () => {
    write(
      "android/build.gradle",
      'classpath("com.android.tools.build:gradle:8.2.1")',
    );
    expect(findSandboxGradleBlocker({})).toBeNull();
  });

  it.each([
    ["Release", "release"],
    ["stagingRelease", "release"],
    ["Beta", "beta"],
  ])(
    "refuses a project's own manifest for %s's build type",
    (variant, buildType) => {
      write("android/gradle.properties", "android.newDsl=false\n");
      write(`android/app/src/${buildType}/AndroidManifest.xml`, "<manifest/>");
      expect(findSandboxGradleBlocker({ variant })).toBe(
        `A sandbox build can't merge with android/app/src/${buildType}/AndroidManifest.xml.\nMove what it declares to src/main/AndroidManifest.xml.`,
      );
    },
  );

  it("ignores another build type's manifest", () => {
    write("android/gradle.properties", "android.newDsl=false\n");
    write("android/app/src/debug/AndroidManifest.xml", "<manifest/>");
    expect(findSandboxGradleBlocker({})).toBeNull();
  });
});
