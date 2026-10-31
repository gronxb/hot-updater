import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

import type {
  NativeFingerprint,
  NativeFingerprintOptions,
  NativeFingerprintSource,
  Platform,
} from "@hot-updater/plugin-core";
import { execa } from "execa";
import fg from "fast-glob";
import { parseYaml } from "workspace-tools/lib/lockfile/readYaml.js";

const require = createRequire(import.meta.url);

/**
 * The engine fingerprint.json records for the interface fingerprint. Change
 * it with any change to what is hashed or how, so the new hashes are reported
 * as an engine change rather than a native one.
 */
export const INTERFACE_FINGERPRINT_ENGINE = "hot-updater/interface@1";

const GENERATED_DIRS = [
  "**/node_modules/**",
  "**/build/**",
  "**/Pods/**",
  "**/.gradle/**",
  "**/.cxx/**",
  "**/DerivedData/**",
];

// Tests of a local package don't ship in the app.
const TEST_DIRS = [
  "**/{test,tests,Tests,androidTest,__tests__}/**",
  "**/*Tests.swift",
  "**/*Test.{kt,java}",
];

const NATIVE_FILES = {
  ios: [
    "*.podspec",
    "ios/**/*.{h,hpp,hxx,m,mm,c,cc,cpp,cxx,swift}",
    "apple/**/*.{h,hpp,hxx,m,mm,c,cc,cpp,cxx,swift}",
  ],
  android: [
    "android/**/*.{java,kt,c,cc,cpp,cxx,h,hpp,hxx,gradle,kts}",
    "android/**/CMakeLists.txt",
  ],
} as const;

/**
 * A native package linked into the app: its directory, when it comes from a
 * package manager, or its name and version, when the framework declares it
 * elsewhere (a CocoaPods or Maven dependency).
 */
export type NativeDependency =
  | {
      name: string;
      root: string;
      /**
       * Where autolinking finds the platform's native code when it isn't the
       * package's `ios`/`android` folder: Android's `sourceDir`, or the
       * folder of the iOS podspec. An Expo module can name several.
       */
      sourceDirs?: string[];
      /** Prebuilt native files autolinking links, such as an Expo module's AARs. */
      files?: string[];
    }
  | { name: string; version: string };

/**
 * The folders under `dir` that hold a package of their own, such as an example
 * app beside a library's podspec: their files belong to that package.
 */
const nestedPackages = async (dir: string): Promise<string[]> =>
  (
    await fg("**/package.json", {
      cwd: dir,
      ignore: [...GENERATED_DIRS],
    })
  )
    .map((file) => path.posix.dirname(file))
    .filter((folder) => folder !== ".")
    .map((folder) => `${folder}/**`);

/** A platform's native files in a folder autolinking points at. */
const NATIVE_SOURCE_FILES = {
  ios: ["*.podspec", "**/*.{h,hpp,hxx,m,mm,c,cc,cpp,cxx,swift}"],
  android: [
    "**/*.{java,kt,c,cc,cpp,cxx,h,hpp,hxx,gradle,kts}",
    "**/CMakeLists.txt",
  ],
} as const;

/**
 * The folder autolinking reads a dependency's native code from, when the
 * config names one: Android's `sourceDir`, or the iOS podspec's folder.
 */
const nativeSourceDir = (
  platform: Platform,
  config: unknown,
): string | undefined => {
  if (!config || typeof config !== "object") return undefined;
  const value =
    platform === "ios"
      ? (config as { podspecPath?: unknown }).podspecPath
      : (config as { sourceDir?: unknown }).sourceDir;
  if (typeof value !== "string") return undefined;
  return platform === "ios" ? path.dirname(value) : value;
};

/**
 * The native side JavaScript runs against: the runtime, such as
 * `react-native@0.85.0`, and the native packages linked into the app.
 */
export interface NativeInterface {
  runtime: string;
  dependencies: NativeDependency[];
  /**
   * Native settings that decide how JavaScript runs, such as the JavaScript
   * engine, read from the files the framework itself reads.
   */
  settings?: Record<string, string>;
  /**
   * What autolinking printed, as parsed: the React Native config, and
   * expo-modules-autolinking's `resolve` when the app links Expo modules.
   */
  autolinking?: {
    reactNative: unknown;
    expoModules: unknown;
  };
}

interface AutolinkingConfig {
  reactNativePath?: string;
  project?: {
    ios?: { sourceDir?: string };
    android?: { sourceDir?: string };
  };
  dependencies?: Record<
    string,
    { name?: string; root?: string; platforms?: Record<string, unknown> }
  >;
}

const readManifest = async (
  dir: string,
): Promise<{
  name?: string;
  version?: string;
  codegenConfig?: {
    jsSrcsDir?: string;
    /** The deprecated form React Native codegen still reads. */
    libraries?: { jsSrcsDir?: string }[];
  };
} | null> => {
  try {
    return JSON.parse(
      await fs.readFile(path.join(dir, "package.json"), "utf8"),
    );
  } catch {
    return null;
  }
};

const parseJsonOutput = <T>(stdout: string, command: string): T => {
  const start = stdout.indexOf("{");
  try {
    if (start >= 0) return JSON.parse(stdout.slice(start)) as T;
  } catch {
    // Reported below with the command that printed it.
  }
  throw new Error(
    `\`${command}\` printed no JSON configuration. Check that it runs in this project.`,
  );
};

const findPackageRoot = async (from: string, name: string) => {
  let dir = from;
  while (true) {
    if ((await readManifest(dir))?.name === name) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
};

/**
 * A local Expo module's registration for `platform`, from its
 * expo-module.config.json (or legacy unimodule.json): whether it lists the platform, the platform's
 * own section, and the native features it requires. Other platforms' and
 * non-native sections, such as `web` and `devtools`, leave it alone.
 */
const readExpoModuleConfig = async (
  root: string,
  platform: Platform,
): Promise<string | null> => {
  // Expo autolinking reads the first of these it finds; unimodule.json is
  // the legacy name.
  let file: string | null = null;
  for (const name of ["expo-module.config.json", "unimodule.json"]) {
    file = await fs.readFile(path.join(root, name), "utf8").catch(() => null);
    if (file !== null) break;
  }
  if (file === null) return null;
  const config = JSON.parse(file) as Record<string, unknown>;
  const names = platform === "ios" ? ["apple", "ios"] : ["android"];
  // `ios` is the legacy name of `apple`, read only when `apple` is absent.
  const section =
    platform === "ios" ? (config["apple"] ?? config["ios"]) : config["android"];
  // Key order means nothing to Expo.
  return stableStringify({
    listed: Array.isArray(config["platforms"])
      ? names.some((name) => (config["platforms"] as unknown[]).includes(name))
      : null,
    coreFeatures: config["coreFeatures"] ?? null,
    section: section ?? null,
  });
};

interface ExpoModule {
  packageName?: string;
  packageVersion?: string;
  projects?: { sourceDir?: string; aarProjects?: { aarFilePath?: string }[] }[];
  plugins?: { sourceDir?: string }[];
  pods?: { podspecDir?: string }[];
  /** SDKs before 53 list a module's AARs here. */
  aarProjects?: { aarFilePath?: string }[];
}

const atLeast = (version: string, minimum: [number, number, number]) => {
  const parts = version.split(/[.+-]/u).map(Number);
  for (let index = 0; index < 3; index++) {
    const part = parts[index] ?? 0;
    if (part !== minimum[index]) return part > minimum[index]!;
  }
  return true;
};

/** The arguments that run React Native CLI's `config` with Node.js. */
const reactNativeCliConfig = (cwd: string) => [
  path.join(
    path.dirname(
      require.resolve("react-native/package.json", { paths: [cwd] }),
    ),
    "cli.js",
  ),
  "config",
];

/**
 * The command, run with Node.js, that lists the React Native packages a
 * build links, chosen as Expo and @expo/fingerprint choose it: Expo's
 * autolinking from expo-modules-autolinking 1.12 (SDK 52), else React Native
 * CLI, as for an app without Expo. The native templates also fall back to
 * React Native CLI when `EXPO_USE_COMMUNITY_AUTOLINKING=1`, as Expo
 * documents.
 */
export const reactNativeConfigCommand = (
  cwd: string,
  platform: Platform,
  env: NodeJS.ProcessEnv = process.env,
): string[] => {
  let autolinking: ReturnType<typeof resolveExpoAutolinking> | null = null;
  try {
    autolinking = resolveExpoAutolinking(cwd);
  } catch {
    // No Expo: React Native CLI links the app.
  }
  if (
    autolinking?.linksReactNative &&
    env["EXPO_USE_COMMUNITY_AUTOLINKING"] !== "1"
  ) {
    return [
      autolinking.bin,
      "react-native-config",
      "--platform",
      platform,
      "--json",
    ];
  }
  return reactNativeCliConfig(cwd);
};

/**
 * The command that lists the React Native packages the native project of a
 * build adapter links, as the adapter's own fingerprint runs it: `rock config`
 * for Rock, React Native CLI's `config` for the bare adapter, and
 * {@link reactNativeConfigCommand} for Expo and any other adapter.
 */
export const autolinkingConfigCommand = (
  cwd: string,
  platform: Platform,
  {
    buildAdapter,
    env = process.env,
  }: { buildAdapter?: string; env?: NodeJS.ProcessEnv } = {},
): { command: string; args: string[] } => {
  if (buildAdapter === "rock") {
    return { command: "npx", args: ["rock", "config", "-p", platform] };
  }
  return {
    command: process.execPath,
    args:
      buildAdapter === "bare"
        ? reactNativeCliConfig(cwd)
        : reactNativeConfigCommand(cwd, platform, env),
  };
};

/**
 * The expo-modules-autolinking an Expo app builds with, resolved from its
 * `expo` package as the native templates resolve it.
 */
export const resolveExpoAutolinking = (
  cwd: string,
): {
  bin: string;
  version: string;
  /** Whether it lists React Native packages (`react-native-config`, 1.12+). */
  linksReactNative: boolean;
} => {
  const expo = path.dirname(
    require.resolve("expo/package.json", { paths: [cwd] }),
  );
  const manifest = require.resolve("expo-modules-autolinking/package.json", {
    paths: [expo],
  });
  const { version = "0.0.0" } = JSON.parse(readFileSync(manifest, "utf8")) as {
    version?: string;
  };
  return {
    bin: path.join(path.dirname(manifest), "bin/expo-modules-autolinking.js"),
    version,
    // The version @expo/fingerprint switches React Native core autolinking
    // to Expo at, for SDK 52 and later.
    linksReactNative: atLeast(version, [1, 12, 0]),
  };
};

/**
 * The Expo modules linked into a React Native app through
 * `use_expo_modules!` / `useExpoModules()`. React Native CLI's config lists
 * only the `expo` package for them, so they are read from
 * expo-modules-autolinking.
 */
const readExpoModules = async (
  cwd: string,
  platform: Platform,
): Promise<{ dependencies: NativeDependency[]; output: unknown }> => {
  const { bin, version } = resolveExpoAutolinking(cwd);
  // expo-modules-autolinking 1.10 renamed the iOS platform `apple`.
  const name =
    platform === "android"
      ? "android"
      : atLeast(version, [1, 10, 0])
        ? "apple"
        : "ios";
  const result = await execa(
    process.execPath,
    [bin, "resolve", "--platform", name, "--json"],
    { cwd, reject: false },
  );
  if (result.exitCode !== 0) {
    throw new Error("`expo-modules-autolinking resolve` failed.");
  }
  const output = parseJsonOutput<{ modules?: ExpoModule[] }>(
    result.stdout,
    "expo-modules-autolinking resolve",
  );
  return {
    dependencies: await readExpoModuleDependencies(output.modules ?? []),
    output,
  };
};

const readExpoModuleDependencies = (
  modules: ExpoModule[],
): Promise<NativeDependency[]> =>
  Promise.all(
    modules.flatMap((module) => {
      const name = module.packageName;
      if (!name) return [];
      // Every Android project, Gradle plugin, and iOS pod the module declares.
      const sourceDirs = [
        ...(module.projects ?? []).map(({ sourceDir }) => sourceDir),
        ...(module.plugins ?? []).map(({ sourceDir }) => sourceDir),
        ...(module.pods ?? []).map(({ podspecDir }) => podspecDir),
      ].filter((dir): dir is string => Boolean(dir));
      const files = [
        ...(module.projects ?? []).flatMap(
          ({ aarProjects }) => aarProjects ?? [],
        ),
        ...(module.aarProjects ?? []),
      ]
        .map(({ aarFilePath }) => aarFilePath)
        .filter((file): file is string => Boolean(file));
      return [
        (async (): Promise<NativeDependency> => {
          const anchor = sourceDirs[0] ?? files[0];
          const root = anchor ? await findPackageRoot(anchor, name) : null;
          return root
            ? { name, root, sourceDirs, ...(files.length > 0 ? { files } : {}) }
            : { name, version: module.packageVersion ?? "unknown" };
        })(),
      ];
    }),
  );

// The gradle.properties keys the React Native Gradle plugin reads to choose
// the JavaScript engine and architecture.
const GRADLE_FLAGS = [
  "hermesEnabled",
  "hermesV1Enabled",
  "react.hermesV1Enabled",
  "newArchEnabled",
];

/**
 * The engine and architecture flags android/gradle.properties declares. An
 * absent flag takes React Native's default, which follows its version.
 */
const readGradleFlags = async (
  androidDir: string,
): Promise<Record<string, string>> => {
  const properties = await fs
    .readFile(path.join(androidDir, "gradle.properties"), "utf8")
    .catch(() => "");
  const flags: Record<string, string> = {};
  // A line ending in an odd number of backslashes continues on the next one,
  // whose leading whitespace is dropped.
  const lines: string[] = [];
  let pending = "";
  for (const line of properties.split(/\r?\n/)) {
    const joined = pending + (pending ? line.trimStart() : line);
    const trailing = /\\*$/.exec(joined)![0].length;
    if (trailing % 2 === 1) {
      pending = joined.slice(0, -1);
      continue;
    }
    lines.push(joined);
    pending = "";
  }
  if (pending) lines.push(pending);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("!")) {
      continue;
    }
    // A key ends at the first `=`, `:`, or whitespace, as Java properties
    // read it; the value follows any whitespace and one `=` or `:`. A line
    // with only a key sets it to an empty value.
    const separator = trimmed.search(/[=:\s]/);
    const end = separator < 0 ? trimmed.length : separator;
    const key = trimmed.slice(0, end);
    if (GRADLE_FLAGS.includes(key)) {
      flags[`android:${key}`] = trimmed
        .slice(end)
        .replace(/^\s*[=:]?/, "")
        .trim();
    }
  }
  return flags;
};

/**
 * Reads the native interface of a React Native app from the JSON its
 * autolinking `config` command prints: `react-native config` for React Native
 * CLI, `rock config -p <platform>` for Rock, `expo-modules-autolinking
 * react-native-config` for Expo. An app that links Expo modules gets them
 * from expo-modules-autolinking as well.
 *
 * The engine and architecture settings come from what the project declares:
 * `settings` when the framework records them elsewhere, such as Expo's app
 * config, else android/gradle.properties. Nothing generated by an install,
 * such as Podfile.lock, is read, so every machine computes the same
 * fingerprint before and after `pod install` or `expo prebuild`.
 */
export const readReactNativeInterface = async ({
  cwd,
  command,
  args,
  platform,
  settings: declaredSettings,
}: {
  cwd: string;
  command: string;
  args: string[];
  platform: Platform;
  settings?: Record<string, string>;
}): Promise<NativeInterface> => {
  const { stdout } = await execa(command, args, { cwd });
  const config = parseJsonOutput<AutolinkingConfig>(
    stdout,
    [path.basename(command), ...args].join(" "),
  );
  const reactNative = config.reactNativePath
    ? await readManifest(config.reactNativePath)
    : null;
  const dependencies: NativeDependency[] = Object.values(
    config.dependencies ?? {},
  ).flatMap((dependency) =>
    dependency.name && dependency.root && dependency.platforms?.[platform]
      ? [
          {
            name: dependency.name,
            root: dependency.root,
            sourceDir: nativeSourceDir(
              platform,
              dependency.platforms[platform],
            ),
          },
        ].map(({ sourceDir, ...rest }) =>
          sourceDir ? { ...rest, sourceDirs: [sourceDir] } : rest,
        )
      : [],
  );
  const linksExpoModules = dependencies.some(({ name }) => name === "expo");
  const expo = linksExpoModules
    ? await readExpoModules(cwd, platform)
    : { dependencies: [], output: null };
  const expoModules = expo.dependencies;
  const names = new Set(dependencies.map(({ name }) => name));
  // iOS declares no engine setting React Native's pods read from a file:
  // `pod install` takes them from the environment.
  const settings =
    declaredSettings ??
    (platform === "android"
      ? await readGradleFlags(
          config.project?.android?.sourceDir ?? path.join(cwd, "android"),
        )
      : {});
  return {
    runtime: `react-native@${reactNative?.version ?? "unknown"}`,
    dependencies: [
      ...dependencies,
      ...expoModules.filter(({ name }) => !names.has(name)),
    ],
    settings,
    autolinking: { reactNative: config, expoModules: expo.output },
  };
};

const sha256 = (data: string | Uint8Array) =>
  createHash("sha256").update(data).digest("hex");

const toPosix = (filePath: string) => filePath.split(path.sep).join("/");

/** JSON with object keys sorted, so key order in package.json doesn't count. */
const stableStringify = (value: unknown): string =>
  JSON.stringify(value, (_key, entry: unknown) =>
    entry && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(
          Object.entries(entry).sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : entry,
  );

/**
 * Whether React Native codegen reads `file` as a spec for `platform`: the
 * rule of its `filterJSFile`, so a fingerprint follows the specs codegen
 * compiles and nothing else in `jsSrcsDir`.
 */
export const isCodegenSpecFile = (original: string, platform: Platform) => {
  // Codegen drops a `.fb` suffix before it reads the name.
  const file = original.replace(/\.fb(\.|$)/, "$1");
  const name = path.basename(file);
  if (
    !/^(Native.+|.+NativeComponent)/.test(name) ||
    name.endsWith(".d.ts") ||
    file.endsWith("NativeUIManager.js") ||
    file.includes("__tests")
  ) {
    return false;
  }
  const parts = name.split(".");
  return parts.length === 2 || parts[1] === platform;
};

const findCodegenSpecs = async (
  packageRoot: string,
  platform: Platform,
): Promise<string[] | null> => {
  const config = (await readManifest(packageRoot))?.codegenConfig;
  // React Native codegen reads `libraries` instead of the single config when
  // it is there.
  const jsSrcsDirs = (config?.libraries ?? (config ? [config] : []))
    .map(({ jsSrcsDir }) => jsSrcsDir)
    .filter((dir): dir is string => Boolean(dir));
  if (jsSrcsDirs.length === 0) return null;
  const files: string[] = [];
  for (const jsSrcsDir of jsSrcsDirs) {
    files.push(
      ...(await fg("**/*.{js,jsx,ts,tsx}", {
        cwd: path.resolve(packageRoot, jsSrcsDir),
        absolute: true,
        ignore: ["**/node_modules/**"],
      })),
    );
  }
  return files
    .filter((file, index) => files.indexOf(file) === index)
    .filter((file) => isCodegenSpecFile(file, platform));
};

const isPatchFor = (file: string, name: string) => {
  const plus = name.replace("/", "+");
  const underscore = name.replace("/", "__");
  return (
    file.startsWith(`${plus}+`) ||
    file.startsWith(`${underscore}@`) ||
    file.startsWith(`${underscore}+`) ||
    file === `${underscore}.patch`
  );
};

const isWorkspaceRoot = async (dir: string) => {
  if (
    await fs
      .access(path.join(dir, "pnpm-workspace.yaml"))
      .then(() => true)
      .catch(() => false)
  ) {
    return true;
  }
  const manifest = (await readManifest(dir)) as { workspaces?: unknown } | null;
  return manifest?.workspaces !== undefined;
};

/**
 * The folders whose patches apply to the app: its own and, in a monorepo,
 * the workspace root, where pnpm and patch-package keep them.
 */
const findPatchRoots = async (cwd: string): Promise<string[]> => {
  let dir = cwd;
  while (!(await isWorkspaceRoot(dir))) {
    const parent = path.dirname(dir);
    if (parent === dir) return [cwd];
    dir = parent;
  }
  return dir === cwd ? [cwd] : [cwd, dir];
};

/** `name` from a `name@version` or `name@npm:version` key. */
const packageNameOf = (key: string) => {
  const at = key.lastIndexOf("@");
  return at > 0 ? key.slice(0, at) : key;
};

/**
 * The patch files a package manager records for each package in `root`:
 * pnpm's and Bun's `patchedDependencies` (in package.json or
 * pnpm-workspace.yaml) and Yarn's `patch:` resolutions.
 */
const findConfiguredPatches = async (
  root: string,
): Promise<{ name: string; file: string }[]> => {
  const manifest = (await readManifest(root)) as {
    patchedDependencies?: Record<string, string>;
    pnpm?: { patchedDependencies?: Record<string, string> };
    resolutions?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  } | null;
  const workspace = await fs
    .readFile(path.join(root, "pnpm-workspace.yaml"), "utf8")
    .then(
      (contents) =>
        parseYaml(contents) as {
          patchedDependencies?: Record<string, string>;
        } | null,
    )
    .catch(() => null);
  const patches = Object.entries({
    ...manifest?.patchedDependencies,
    ...manifest?.pnpm?.patchedDependencies,
    ...workspace?.patchedDependencies,
  }).map(([key, file]) => ({
    name: packageNameOf(key),
    file: path.resolve(root, file),
  }));
  // Yarn's `patch:` protocol, in a resolution (keyed `name@range`) or a
  // dependency (keyed `name`): `patch:<name>@<range>#<file>[::<params>]`.
  for (const [key, value] of [
    ...Object.entries(manifest?.resolutions ?? {}),
    ...Object.entries(manifest?.dependencies ?? {}),
    ...Object.entries(manifest?.devDependencies ?? {}),
    ...Object.entries(manifest?.optionalDependencies ?? {}),
  ]) {
    const hash = value.lastIndexOf("#");
    if (!value.startsWith("patch:") || hash < 0) continue;
    const file = value.slice(hash + 1).split("::")[0]!;
    patches.push({
      name: packageNameOf(key),
      file: path.resolve(root, file.replace(/^~\//, "")),
    });
  }
  return patches;
};

/**
 * Fingerprints the native interface JavaScript depends on, not the native
 * build: the runtime and its native settings, each registry package as
 * `name@version`, the codegen
 * specs of the app and of local packages (a local package without specs by
 * its native files), patches to those packages, `nativeVersion`, and
 * `extraSources`. Version and build numbers, native implementations, and
 * JavaScript-only dependencies leave it unchanged.
 */
export const createInterfaceFingerprint = async (
  cwd: string,
  options: NativeFingerprintOptions,
  nativeInterface: NativeInterface,
): Promise<NativeFingerprint> => {
  const { platform } = options;
  const sources = new Map<string, NativeFingerprintSource>();
  const addContents = (id: string, contents: string, reason: string) => {
    sources.set(`contents:${id}`, {
      type: "contents",
      id,
      contents,
      reasons: [reason],
      hash: sha256(contents),
    });
  };
  const addFile = async (absolutePath: string, reason: string) => {
    const filePath = toPosix(path.relative(cwd, absolutePath));
    sources.set(`file:${filePath}`, {
      type: "file",
      filePath,
      reasons: [reason],
      hash: sha256(await fs.readFile(absolutePath)),
    });
  };

  addContents("runtime", nativeInterface.runtime, "runtime");
  for (const [key, value] of Object.entries(nativeInterface.settings ?? {})) {
    addContents(`setting:${key}`, value, "native-setting");
  }

  // What codegen generates follows its config as well as the specs: `type`
  // decides whether it generates modules, components, or both. The other
  // platform's section (`ios` or `android`) doesn't reach this build.
  const addCodegenConfig = async (root: string) => {
    const config = (await readManifest(root))?.codegenConfig as
      | Record<string, unknown>
      | undefined;
    if (config) {
      const other = platform === "ios" ? "android" : "ios";
      const ownSection = (section: Record<string, unknown>) => {
        const { [other]: _other, ...own } = section;
        return own;
      };
      const own = ownSection(config);
      // The deprecated `libraries` form gives each library its own sections.
      if (Array.isArray(own.libraries)) {
        own.libraries = own.libraries.map((library: unknown) =>
          library && typeof library === "object"
            ? ownSection(library as Record<string, unknown>)
            : library,
        );
      }
      addContents(
        `codegen-config:${toPosix(path.relative(cwd, root)) || "."}`,
        stableStringify(own),
        "codegen-config",
      );
    }
  };

  await addCodegenConfig(cwd);
  for (const specFile of (await findCodegenSpecs(cwd, platform)) ?? []) {
    await addFile(specFile, "app-codegen-spec");
  }

  for (const dependency of nativeInterface.dependencies) {
    if ("version" in dependency) {
      addContents(
        `dependency:${dependency.name}`,
        `${dependency.name}@${dependency.version}`,
        "native-dependency",
      );
      continue;
    }
    const root = await fs.realpath(dependency.root);
    if (root.split(path.sep).includes("node_modules")) {
      const version = (await readManifest(root))?.version ?? "unknown";
      addContents(
        `dependency:${dependency.name}`,
        `${dependency.name}@${version}`,
        "native-dependency",
      );
      continue;
    }
    // A local package keeps its version while its code changes.
    // A package with no spec for this platform, even one with specs for the
    // other, exposes its interface through native code here.
    await addCodegenConfig(root);
    const found = await findCodegenSpecs(root, platform);
    const specs = found && found.length > 0 ? found : null;
    // The package's ios/android folders, and the folder autolinking reads
    // when the package points it elsewhere.
    const files = specs ?? [
      ...(await fg([...NATIVE_FILES[platform]], {
        cwd: root,
        absolute: true,
        ignore: [...GENERATED_DIRS, ...TEST_DIRS],
      })),
    ];
    // An Expo module registers its native classes in expo-module.config.json
    // and can link prebuilt AARs, whether or not it has specs.
    const expoModuleConfig = await readExpoModuleConfig(root, platform);
    if (expoModuleConfig !== null) {
      addContents(
        `expo-module-config:${dependency.name}`,
        expoModuleConfig,
        "local-dependency-expo-module",
      );
    }
    for (const file of dependency.files ?? []) {
      const real = await fs.realpath(file).catch(() => undefined);
      if (real) await addFile(real, "local-dependency-native");
    }
    if (!specs) {
      for (const dir of dependency.sourceDirs ?? []) {
        const sourceDir = await fs.realpath(dir).catch(() => undefined);
        if (!sourceDir) continue;
        files.push(
          ...(await fg([...NATIVE_SOURCE_FILES[platform]], {
            cwd: sourceDir,
            absolute: true,
            ignore: [
              ...GENERATED_DIRS,
              ...TEST_DIRS,
              ...(await nestedPackages(sourceDir)),
            ],
          })),
        );
      }
    }
    for (const file of new Set(files)) {
      await addFile(
        file,
        specs ? "local-dependency-codegen-spec" : "local-dependency-native",
      );
    }
  }

  const patchedNames = [
    "react-native",
    ...nativeInterface.dependencies.map(({ name }) => name),
  ];
  for (const root of await findPatchRoots(cwd)) {
    const dir = path.join(root, "patches");
    const patches = await fs.readdir(dir).catch(() => [] as string[]);
    for (const patch of patches) {
      if (patchedNames.some((name) => isPatchFor(patch, name))) {
        await addFile(path.join(dir, patch), "native-dependency-patch");
      }
    }
    for (const { name, file } of await findConfiguredPatches(root)) {
      // The package manager refuses to install without the file.
      const exists = await fs.access(file).then(
        () => true,
        () => false,
      );
      if (exists && patchedNames.includes(name)) {
        await addFile(file, "native-dependency-patch");
      }
    }
  }

  if (options.nativeVersion !== undefined) {
    addContents("nativeVersion", String(options.nativeVersion), "config");
  }

  const extraSources = Array.isArray(options.extraSources)
    ? options.extraSources
    : (options.extraSources?.[platform] ?? []);
  if (extraSources.length > 0) {
    const files = await fg(extraSources, {
      cwd,
      absolute: true,
      dot: true,
      ignore: [...GENERATED_DIRS, ...(options.ignorePaths ?? [])],
      onlyFiles: false,
      markDirectories: true,
    });
    for (const match of files) {
      // Expand a directory from the project root, so ignorePaths, which
      // are relative to it, apply to the files inside.
      const directory = toPosix(path.relative(cwd, match));
      const prefix = directory.replace(/\/$/, "");
      const matches = match.endsWith("/")
        ? await fg(prefix ? `${prefix}/**/*` : "**/*", {
            cwd,
            absolute: true,
            dot: true,
            ignore: [...GENERATED_DIRS, ...(options.ignorePaths ?? [])],
          })
        : [match];
      for (const file of matches) await addFile(file, "extra-source");
    }
  }

  const sorted = [...sources.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([, source]) => source);
  const digest = createHash("sha256").update(
    `${INTERFACE_FINGERPRINT_ENGINE}\0`,
  );
  for (const source of sorted) {
    digest.update(
      `${source.type}\0${source.type === "contents" ? source.id : source.filePath}\0${source.hash}\0`,
    );
  }
  return {
    engine: INTERFACE_FINGERPRINT_ENGINE,
    hash: digest.digest("hex"),
    sources: sorted,
  };
};

/**
 * The fingerprint of a React Native CLI project: the native interface
 * `react-native config` reports. The bare adapter's fingerprint, and the one
 * a build adapter without its own gets.
 */
export const reactNativeCliFingerprint = async (
  cwd: string,
  options: NativeFingerprintOptions,
) =>
  createInterfaceFingerprint(
    cwd,
    options,
    await readReactNativeInterface({
      cwd,
      command: process.execPath,
      args: reactNativeCliConfig(cwd),
      platform: options.platform,
    }),
  );
