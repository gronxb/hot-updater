import { createHash } from "node:crypto";
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

interface ExpoModule {
  packageName?: string;
  packageVersion?: string;
  projects?: { sourceDir?: string }[];
  pods?: { podspecDir?: string }[];
}

/**
 * The Expo modules linked into a React Native app through
 * `use_expo_modules!` / `useExpoModules()`. React Native CLI's config lists
 * only the `expo` package for them, so they are read from
 * expo-modules-autolinking.
 */
const readExpoModules = async (
  cwd: string,
  platform: Platform,
): Promise<NativeDependency[]> => {
  const expo = path.dirname(
    require.resolve("expo/package.json", { paths: [cwd] }),
  );
  const autolinking = path.dirname(
    require.resolve("expo-modules-autolinking/package.json", {
      paths: [expo],
    }),
  );
  const bin = path.join(autolinking, "bin/expo-modules-autolinking.js");
  // SDKs before `apple` name the iOS platform `ios`.
  let output: string | null = null;
  for (const name of platform === "ios" ? ["apple", "ios"] : ["android"]) {
    const result = await execa(
      process.execPath,
      [bin, "resolve", "--platform", name, "--json"],
      { cwd, reject: false },
    );
    if (result.exitCode === 0) {
      output = result.stdout;
      break;
    }
  }
  if (output === null) {
    throw new Error("`expo-modules-autolinking resolve` failed.");
  }
  const { modules = [] } = parseJsonOutput<{ modules?: ExpoModule[] }>(
    output,
    "expo-modules-autolinking resolve",
  );
  return Promise.all(
    modules.flatMap((module) => {
      const name = module.packageName;
      if (!name) return [];
      // Every Android project and iOS pod the module declares.
      const sourceDirs = [
        ...(module.projects ?? []).map(({ sourceDir }) => sourceDir),
        ...(module.pods ?? []).map(({ podspecDir }) => podspecDir),
      ].filter((dir): dir is string => Boolean(dir));
      return [
        (async (): Promise<NativeDependency> => {
          const root = sourceDirs[0]
            ? await findPackageRoot(sourceDirs[0], name)
            : null;
          return root
            ? { name, root, sourceDirs }
            : { name, version: module.packageVersion ?? "unknown" };
        })(),
      ];
    }),
  );
};

/**
 * The Hermes pod `pod install` resolved, as Podfile.lock records it: its
 * version tells Hermes V1 from legacy Hermes, and its absence means JSC.
 * Without a Podfile.lock there is nothing to read.
 */
const readHermesPod = async (
  iosDir: string,
): Promise<Record<string, string>> => {
  const lock = await fs
    .readFile(path.join(iosDir, "Podfile.lock"), "utf8")
    .catch(() => null);
  if (lock === null) return {};
  const end = lock.indexOf("\nDEPENDENCIES:");
  const pods = end < 0 ? lock : lock.slice(0, end);
  const version = /^ {2}- hermes-engine \(([^)]+)\)/m.exec(pods)?.[1];
  return { "ios:hermes-engine": version ?? "none" };
};

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
 * CLI, `rock config -p <platform>` for Rock. An app that links Expo modules
 * gets them from expo-modules-autolinking as well.
 */
export const readReactNativeInterface = async ({
  cwd,
  command,
  args,
  platform,
}: {
  cwd: string;
  command: string;
  args: string[];
  platform: Platform;
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
  const expoModules = linksExpoModules
    ? await readExpoModules(cwd, platform)
    : [];
  const names = new Set(dependencies.map(({ name }) => name));
  const settings =
    platform === "ios"
      ? await readHermesPod(
          config.project?.ios?.sourceDir ?? path.join(cwd, "ios"),
        )
      : await readGradleFlags(
          config.project?.android?.sourceDir ?? path.join(cwd, "android"),
        );
  return {
    runtime: `react-native@${reactNative?.version ?? "unknown"}`,
    dependencies: [
      ...dependencies,
      ...expoModules.filter(({ name }) => !names.has(name)),
    ],
    settings,
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
