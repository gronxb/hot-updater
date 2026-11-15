import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { WINDOWS_INIT_SCRIPT } from "./windowsGradle";

/**
 * The Gradle the newest example builds with (9.4.1): its wrapper, which
 * downloads that distribution once. It runs under bash, never /bin/sh: dash,
 * Debian's and Ubuntu's /bin/sh, drops an environment variable whose name
 * isn't a shell name, such as ORG_GRADLE_PROJECT_expo.android.cmakeObjectPathMax,
 * before Gradle starts, as runGradle's comment says of the signing ones.
 */
const gradlew = path.resolve(
  import.meta.dirname,
  "../../../../examples/v0.88.0/android/gradlew",
);

/** Java for Gradle: JAVA_HOME's, or the one on the PATH. */
const hasJava = [
  ...(process.env["JAVA_HOME"]
    ? [path.join(process.env["JAVA_HOME"], "bin", "java")]
    : []),
  ...(process.env["PATH"] ?? "")
    .split(path.delimiter)
    .map((directory) => path.join(directory, "java")),
].some((candidate) => fs.existsSync(candidate));

/**
 * The environment of one case: this process's, without a Gradle project
 * property it may carry, and the case's own.
 */
const caseEnvironment = (env: Record<string, string>) => ({
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !name.startsWith("ORG_GRADLE_PROJECT_"),
    ),
  ),
  GRADLE_OPTS: "-Dorg.gradle.welcome=never",
  ...env,
});

// The Android Gradle plugin's part the script uses: the plugin id, and the
// DSL `androidComponents.finalizeDsl` hands over once the module's build
// script ran.
const FAKE_ANDROID_PLUGIN = `
import org.gradle.api.Plugin
import org.gradle.api.Project

class FakeAndroidPlugin implements Plugin<Project> {
  void apply(Project project) {
    def android = [
      defaultConfig: [externalNativeBuild: [cmake: [arguments: []]]],
      buildTypes: [],
      productFlavors: [],
    ]
    def components = new FakeAndroidComponents(android: android)
    project.extensions.add('android', android)
    project.extensions.add('androidComponents', components)
    project.afterEvaluate {
      components.callbacks.each { it(android) }
      println "CMAKE_ARGUMENTS " + android.defaultConfig.externalNativeBuild.cmake.arguments
    }
  }
}

class FakeAndroidComponents {
  def android
  List<Closure> callbacks = []
  void finalizeDsl(Closure callback) { callbacks << callback }
}
`;

// expo-modules-autolinking 58.0.7's ExpoRootProjectPlugin.kt:
// setDefaultCmakeObjectPathMax() and cmakeObjectPathMax(), as the root
// project applies them: 1024 when the property is unset or empty, no
// argument for 0, and the value otherwise.
const ROOT_BUILD = `
if (!findProperty('fake.noExpo')) {
  def raw = (findProperty('expo.android.cmakeObjectPathMax') instanceof String
    ? findProperty('expo.android.cmakeObjectPathMax') : null)?.trim()
  def value = !raw ? 1024 : (raw.isInteger() ? raw.toInteger() : 1024)
  if (value != 0) {
    allprojects { p ->
      p.pluginManager.withPlugin('com.android.application') {
        p.android.defaultConfig.externalNativeBuild.cmake.arguments.add(
          '-DCMAKE_OBJECT_PATH_MAX=' + value)
      }
    }
  }
}
`;

const execFileAsync = promisify(execFile);

// The script runs on Windows hosts only, but what it does with Gradle's
// properties is the same on any; bash runs the wrapper here.
describe.skipIf(!hasJava || process.platform === "win32")(
  "the Windows init script with real Gradle",
  () => {
    let project: string;
    let script: string;

    beforeAll(async () => {
      project = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), "windows-gradle-"),
      );
      const write = async (file: string, text: string) => {
        await fs.promises.mkdir(path.dirname(path.join(project, file)), {
          recursive: true,
        });
        await fs.promises.writeFile(path.join(project, file), text);
      };
      await write("settings.gradle", "include ':app'\n");
      await write("build.gradle", ROOT_BUILD);
      await write(
        "app/build.gradle",
        `plugins { id 'com.android.application' }
if (findProperty('fake.ownLimit')) {
  android.defaultConfig.externalNativeBuild.cmake.arguments.add('-DCMAKE_OBJECT_PATH_MAX=180')
}
`,
      );
      await write(
        "buildSrc/build.gradle",
        `plugins { id 'groovy'; id 'java-gradle-plugin' }
dependencies { implementation localGroovy() }
gradlePlugin {
  plugins {
    fakeAndroid { id = 'com.android.application'; implementationClass = 'FakeAndroidPlugin' }
  }
}
`,
      );
      await write(
        "buildSrc/src/main/groovy/FakeAndroidPlugin.groovy",
        FAKE_ANDROID_PLUGIN,
      );
      script = path.join(project, "windows.init.gradle");
      await fs.promises.writeFile(script, WINDOWS_INIT_SCRIPT);
    }, 60_000);

    afterAll(async () => {
      await fs.promises.rm(project, { recursive: true, force: true });
    });

    /** The app module's CMake arguments once its DSL is final. */
    const cmakeArguments = async (
      args: string[] = [],
      env: Record<string, string> = {},
      gradleProperties = "",
    ) => {
      await fs.promises.writeFile(
        path.join(project, "gradle.properties"),
        gradleProperties,
      );
      // A JVM of its own per case (--no-daemon), started with that case's
      // environment and properties.
      const { stdout } = await execFileAsync(
        "bash",
        [
          gradlew,
          "--project-dir",
          project,
          "--offline",
          "--no-daemon",
          "--quiet",
          "--init-script",
          script,
          ...args,
          "help",
        ],
        { cwd: project, env: caseEnvironment(env) },
      );
      return /CMAKE_ARGUMENTS (.*)/.exec(stdout)?.[1];
    };

    it("has Expo pass 259, through its own property", async () => {
      expect(await cmakeArguments()).toBe("[-DCMAKE_OBJECT_PATH_MAX=259]");
    }, 300_000);

    it("keeps an Expo value the project set", async () => {
      expect(
        await cmakeArguments(["-Pexpo.android.cmakeObjectPathMax=300"]),
      ).toBe("[-DCMAKE_OBJECT_PATH_MAX=300]");
    }, 300_000);

    // Expo's 0 asks for CMake's own defaults: no definition at all.
    it.each([
      ["-P", ["-Pexpo.android.cmakeObjectPathMax=0"], {}, ""],
      ["gradle.properties", [], {}, "expo.android.cmakeObjectPathMax=0\n"],
      [
        "the environment",
        [],
        { "ORG_GRADLE_PROJECT_expo.android.cmakeObjectPathMax": "0" },
        "",
      ],
    ] as const)(
      "adds nothing when %s turns Expo's limit off with 0",
      async (_, args, env, properties) => {
        expect(await cmakeArguments([...args], env, properties)).toBe("[]");
      },
      300_000,
    );

    it("passes 259 to an app without Expo", async () => {
      expect(await cmakeArguments(["-Pfake.noExpo=true"])).toBe(
        "[-DCMAKE_OBJECT_PATH_MAX=259]",
      );
    }, 300_000);

    it("keeps a module's own limit", async () => {
      expect(
        await cmakeArguments(["-Pfake.noExpo=true", "-Pfake.ownLimit=true"]),
      ).toBe("[-DCMAKE_OBJECT_PATH_MAX=180]");
    }, 300_000);
  },
);
