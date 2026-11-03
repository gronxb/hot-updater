import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let root: string;

vi.mock("@hot-updater/cli-tools", () => ({ getCwd: () => root }));

import {
  findSandboxGradleBlocker,
  sandboxInitScript,
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
  packageName: "com.example.app",
};

const mergedManifest =
  async () => `<manifest xmlns:android="http://schemas.android.com/apk/res/android">
  <application>
    <activity android:name="com.example.app.MainActivity">
      <intent-filter>
        <action android:name="android.intent.action.MAIN" />
        <category android:name="android.intent.category.LAUNCHER" />
      </intent-filter>
    </activity>
  </application>
</manifest>`;

describe("withSandboxGradleArgs", () => {
  it("adds nothing for a normal scheme", async () => {
    const build = vi.fn(async (args: string[]) => args);
    const readManifest = vi.fn(mergedManifest);
    expect(
      await withSandboxGradleArgs(
        { ...scheme, sandbox: false },
        readManifest,
        build,
      ),
    ).toEqual([]);
    expect(readManifest).not.toHaveBeenCalled();
  });

  it("names the init script, the SDK's property, and no incremental Kotlin, then removes its files", async () => {
    let written: { script: string; overlay: string } | undefined;
    const args = await withSandboxGradleArgs(
      scheme,
      mergedManifest,
      async (gradleArgs) => {
        const script = gradleArgs[gradleArgs.indexOf("--init-script") + 1]!;
        written = {
          script,
          overlay: path.join(path.dirname(script), "AndroidManifest.xml"),
        };
        expect(fs.readFileSync(written.script, "utf-8")).toContain(
          `new File('${written.overlay}')`,
        );
        const overlay = fs.readFileSync(written.overlay, "utf-8");
        expect(overlay).toContain('android:value="sandbox-release"');
        expect(overlay).toContain(
          'android:scheme="hu-sandbox-com-example-app"',
        );
        return gradleArgs;
      },
    );
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

  it("builds nothing when the launcher can't be taken over", async () => {
    const build = vi.fn(async () => "built");
    await expect(
      withSandboxGradleArgs(scheme, async () => "<manifest/>", build),
    ).rejects.toThrow("has none");
    expect(build).not.toHaveBeenCalled();
  });

  it("refuses a sandbox scheme with no package name, which its URL scheme needs", async () => {
    await expect(
      withSandboxGradleArgs(
        { ...scheme, packageName: "" },
        mergedManifest,
        async () => "built",
      ),
    ).rejects.toThrow("sets no packageName");
  });

  it("passes the lowest version code to the init script", async () => {
    await withSandboxGradleArgs(
      scheme,
      mergedManifest,
      async (gradleArgs) => {
        const script = gradleArgs[gradleArgs.indexOf("--init-script") + 1]!;
        expect(fs.readFileSync(script, "utf-8")).toContain(
          "def minVersionCode = 42",
        );
      },
      { minVersionCode: 42 },
    );
  });
});

describe("the files a sandbox build writes", () => {
  it("refuses an app whose SDK isn't compiled from source", () => {
    const script = sandboxInitScript({
      appModuleName: "app",
      variant: "release",
      overlay: "/tmp/overlay.xml",
    });
    expect(script).toContain("hotUpdaterSandboxSdkProject");
    expect(script).toContain("gradle.taskGraph.whenReady");
    expect(script).toContain("prebuilt AAR");
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

  it("raises the version code past the store's, in defaultConfig and any flavor, only when asked", () => {
    const raised = sandboxInitScript({
      appModuleName: "app",
      variant: "Release",
      overlay: "/tmp/AndroidManifest.xml",
      minVersionCode: 42,
    });
    expect(raised).toContain("def minVersionCode = 42");
    expect(raised).toContain(
      "dsl.defaultConfig.versionCode = Math.max(dsl.defaultConfig.versionCode ?: 0, minVersionCode)",
    );
    expect(raised).toContain(
      "flavor.versionCode = Math.max(flavor.versionCode, minVersionCode)",
    );
    expect(
      sandboxInitScript({
        appModuleName: "app",
        variant: "Release",
        overlay: "/tmp/AndroidManifest.xml",
      }),
    ).toContain("def minVersionCode = null");
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
