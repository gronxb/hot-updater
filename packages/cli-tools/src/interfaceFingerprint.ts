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
    "ios/**/*.{h,hpp,m,mm,c,cc,cpp,swift}",
    "apple/**/*.{h,hpp,m,mm,c,cc,cpp,swift}",
  ],
  android: [
    "android/**/*.{java,kt,c,cc,cpp,h,hpp,gradle,kts}",
    "android/**/CMakeLists.txt",
  ],
} as const;

/**
 * A native package linked into the app: its directory, when it comes from a
 * package manager, or its name and version, when the framework declares it
 * elsewhere (a CocoaPods or Maven dependency).
 */
export type NativeDependency =
  | { name: string; root: string }
  | { name: string; version: string };

/**
 * The native side JavaScript runs against: the runtime, such as
 * `react-native@0.85.0`, and the native packages linked into the app.
 */
export interface NativeInterface {
  runtime: string;
  dependencies: NativeDependency[];
}

interface AutolinkingConfig {
  reactNativePath?: string;
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
  codegenConfig?: { jsSrcsDir?: string };
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
      const from =
        module.projects?.[0]?.sourceDir ?? module.pods?.[0]?.podspecDir;
      return [
        (async (): Promise<NativeDependency> => {
          const root = from ? await findPackageRoot(from, name) : null;
          return root
            ? { name, root }
            : { name, version: module.packageVersion ?? "unknown" };
        })(),
      ];
    }),
  );
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
      ? [{ name: dependency.name, root: dependency.root }]
      : [],
  );
  const linksExpoModules = dependencies.some(({ name }) => name === "expo");
  const expoModules = linksExpoModules
    ? await readExpoModules(cwd, platform)
    : [];
  const names = new Set(dependencies.map(({ name }) => name));
  return {
    runtime: `react-native@${reactNative?.version ?? "unknown"}`,
    dependencies: [
      ...dependencies,
      ...expoModules.filter(({ name }) => !names.has(name)),
    ],
  };
};

const sha256 = (data: string | Uint8Array) =>
  createHash("sha256").update(data).digest("hex");

const toPosix = (filePath: string) => filePath.split(path.sep).join("/");

/**
 * Whether React Native codegen reads `file` as a spec for `platform`: the
 * rule of its `filterJSFile`, so a fingerprint follows the specs codegen
 * compiles and nothing else in `jsSrcsDir`.
 */
export const isCodegenSpecFile = (file: string, platform: Platform) => {
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
  const jsSrcsDir = (await readManifest(packageRoot))?.codegenConfig?.jsSrcsDir;
  if (!jsSrcsDir) return null;
  const files = await fg("**/*.{js,jsx,ts,tsx}", {
    cwd: path.resolve(packageRoot, jsSrcsDir),
    absolute: true,
    ignore: ["**/node_modules/**"],
  });
  return files.filter((file) => isCodegenSpecFile(file, platform));
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
 * The `patches/` directories that apply to the app: its own and, in a
 * monorepo, the workspace root's, where pnpm and patch-package keep them.
 */
const findPatchDirs = async (cwd: string): Promise<string[]> => {
  const dirs = [path.join(cwd, "patches")];
  let dir = cwd;
  while (!(await isWorkspaceRoot(dir))) {
    const parent = path.dirname(dir);
    if (parent === dir) return dirs;
    dir = parent;
  }
  if (dir !== cwd) dirs.push(path.join(dir, "patches"));
  return dirs;
};

/**
 * Fingerprints the native interface JavaScript depends on, not the native
 * build: the runtime, each registry package as `name@version`, the codegen
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
    const specs = await findCodegenSpecs(root, platform);
    const files =
      specs ??
      (await fg([...NATIVE_FILES[platform]], {
        cwd: root,
        absolute: true,
        ignore: [...GENERATED_DIRS, ...TEST_DIRS],
      }));
    for (const file of files) {
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
  for (const dir of await findPatchDirs(cwd)) {
    const patches = await fs.readdir(dir).catch(() => [] as string[]);
    for (const patch of patches) {
      if (patchedNames.some((name) => isPatchFor(patch, name))) {
        await addFile(path.join(dir, patch), "native-dependency-patch");
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
      const matches = match.endsWith("/")
        ? await fg("**/*", {
            cwd: match,
            absolute: true,
            dot: true,
            ignore: GENERATED_DIRS,
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
