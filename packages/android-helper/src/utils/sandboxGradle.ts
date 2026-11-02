import fs from "fs";
import { createRequire } from "module";
import os from "os";
import path from "path";

import { getCwd } from "@hot-updater/cli-tools";
import {
  SANDBOX_APPLICATION_ID_SUFFIX,
  sandboxChannelOf,
} from "@hot-updater/protocol/native-artifact";

import {
  resolveSandboxLauncher,
  sandboxManifestOverlay,
} from "./sandboxManifest";

const UNSUPPORTED_DSL = `Sandbox builds don't support AGP 9's default DSL yet.
Set android.newDsl=false in android/gradle.properties.`;

/** The message when the build type has a manifest the overlay would replace. */
const ownManifest = (manifest: string) =>
  `A sandbox build can't merge with ${manifest}.\nMove what it declares to src/main/AndroidManifest.xml.`;

/** Text as a single-quoted Groovy string. */
const groovyString = (text: string) =>
  `'${text
    .replace(/\\/gu, "\\\\")
    .replace(/'/gu, "\\'")
    .replace(/\n/gu, "\\n")}'`;

/**
 * The init script of one sandbox build, so no project file changes: on the app
 * module, it appends the sandbox's suffix to defaultConfig, where AGP puts any
 * flavor's and build type's after it, and adds `overlay` to the variant's build
 * type. It runs in `finalizeDsl`, after the project's own settings.
 */
export const sandboxInitScript = ({
  appModuleName,
  variant,
  overlay,
  minVersionCode,
}: {
  appModuleName: string;
  variant: string;
  overlay: string;
  /** The lowest version code the build may have, which raises the project's. */
  minVersionCode?: number;
}) => `// Written by hot-updater for one sandbox build.
def appModule = ${groovyString(`:${appModuleName}`)}
def variant = ${groovyString(variant.toLowerCase())}
def overlay = new File(${groovyString(overlay)})
def minVersionCode = ${minVersionCode ?? "null"}
allprojects { project ->
  if (project.path != appModule) return
  project.plugins.withId('com.android.application') {
    def components = project.extensions.getByName('androidComponents')
    if (components.pluginVersion.major >= 9 && project.findProperty('android.newDsl')?.toString() != 'false') {
      throw new GradleException(${groovyString(UNSUPPORTED_DSL)})
    }
    components.finalizeDsl { dsl ->
      def buildType = dsl.buildTypes.collect { it.name }
        .findAll { variant.endsWith(it.toLowerCase()) }
        .max { it.length() }
      if (buildType == null) {
        throw new GradleException("No build type of \${project.path} builds variant \${variant}.")
      }
      def manifest = dsl.sourceSets.getByName(buildType).manifest
      def own = manifest.srcFile
      if (own.exists()) {
        throw new GradleException(${groovyString(ownManifest("@MANIFEST@"))}.replace('@MANIFEST@', 'android/' + project.rootDir.toPath().relativize(own.toPath())))
      }
      dsl.defaultConfig.applicationIdSuffix = (dsl.defaultConfig.applicationIdSuffix ?: '') + ${groovyString(SANDBOX_APPLICATION_ID_SUFFIX)}
      manifest.srcFile(overlay)
      if (minVersionCode != null) {
        dsl.defaultConfig.versionCode = Math.max(dsl.defaultConfig.versionCode ?: 0, minVersionCode)
        dsl.productFlavors.each { flavor ->
          if (flavor.versionCode != null) flavor.versionCode = Math.max(flavor.versionCode, minVersionCode)
        }
      }
    }
  }
}
`;

/**
 * Runs `build` with the Gradle arguments of a scheme: none for a normal one. A
 * sandbox scheme's attach the SDK's sandbox layer and name the init script,
 * written outside the project with its manifest overlay, and removed after.
 * Kotlin compiles from scratch, since the sandbox layer's sources come and go.
 * `readEffectiveManifest` is the variant's merged manifest before the overlay,
 * which the overlay takes the launcher from.
 */
export const withSandboxGradleArgs = async <T>(
  scheme: {
    readonly sandbox?: boolean;
    readonly hotUpdaterSchemeName: string;
    readonly appModuleName: string;
    readonly variant: string;
    readonly packageName?: string;
  },
  readEffectiveManifest: () => Promise<string>,
  build: (args: string[]) => Promise<T>,
  {
    minVersionCode,
  }: {
    /** The lowest version code a sandbox build may have. */
    minVersionCode?: number;
  } = {},
): Promise<T> => {
  if (!scheme.sandbox) return build([]);
  if (!scheme.packageName) {
    throw new Error(
      `The sandbox scheme ${scheme.hotUpdaterSchemeName} sets no packageName, which its URL scheme comes from.\nSet packageName on the scheme.`,
    );
  }
  const launcher = resolveSandboxLauncher(await readEffectiveManifest());
  const directory = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "hot-updater-sandbox-"),
  );
  try {
    const overlay = path.join(directory, "AndroidManifest.xml");
    const initScript = path.join(directory, "sandbox.init.gradle");
    await fs.promises.writeFile(
      overlay,
      sandboxManifestOverlay({
        channel: sandboxChannelOf(scheme.hotUpdaterSchemeName),
        appId: scheme.packageName,
        launcher,
      }),
    );
    await fs.promises.writeFile(
      initScript,
      sandboxInitScript({
        appModuleName: scheme.appModuleName,
        variant: scheme.variant,
        overlay,
        ...(minVersionCode === undefined ? {} : { minVersionCode }),
      }),
    );
    return await build([
      "--init-script",
      initScript,
      `-PhotUpdaterSandbox=${scheme.hotUpdaterSchemeName}`,
      "-Pkotlin.incremental=false",
    ]);
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
};

/** The major version of the Android Gradle Plugin the project pins, or null. */
const readAgpMajor = (androidProjectPath: string): number | null => {
  const rootBuild = ["build.gradle", "build.gradle.kts"]
    .map((file) => path.join(androidProjectPath, file))
    .filter((file) => fs.existsSync(file))
    .map((file) => fs.readFileSync(file, "utf-8"))
    .join("\n");
  const pinned = /com\.android\.tools\.build:gradle:(\d+)/u.exec(rootBuild);
  if (pinned) return Number(pinned[1]);
  // React Native's version catalog, when the project takes its version.
  try {
    const manifest = createRequire(
      path.join(androidProjectPath, "package.json"),
    ).resolve("react-native/package.json");
    const catalog = fs.readFileSync(
      path.join(path.dirname(manifest), "gradle/libs.versions.toml"),
      "utf-8",
    );
    const agp = /^\s*agp\s*=\s*"(\d+)/mu.exec(catalog);
    return agp ? Number(agp[1]) : null;
  } catch {
    return null;
  }
};

/**
 * Why a sandbox build of a scheme can't work, read from the project's files
 * before anything is built, or null. The init script checks again, with what
 * Gradle actually resolved.
 */
export const findSandboxGradleBlocker = ({
  variant = "Release",
  appModuleName = "app",
}: {
  readonly variant?: string;
  readonly appModuleName?: string;
}): string | null => {
  const androidProjectPath = path.join(getCwd(), "android");
  if (!fs.existsSync(androidProjectPath)) return null;
  const properties = path.join(androidProjectPath, "gradle.properties");
  const newDsl = fs.existsSync(properties)
    ? /^\s*android\.newDsl\s*=\s*(\S+)/mu.exec(
        fs.readFileSync(properties, "utf-8"),
      )?.[1]
    : undefined;
  if (
    newDsl === "true" ||
    (newDsl === undefined && (readAgpMajor(androidProjectPath) ?? 0) >= 9)
  ) {
    return UNSUPPORTED_DSL;
  }
  // `stagingRelease` builds `release`.
  const buildType = /([A-Z]?[a-z0-9]+)$/u.exec(variant)?.[1]?.toLowerCase();
  const manifest = `${appModuleName}/src/${buildType}/AndroidManifest.xml`;
  return buildType && fs.existsSync(path.join(androidProjectPath, manifest))
    ? ownManifest(`android/${manifest}`)
    : null;
};
