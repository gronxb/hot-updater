import { createHash } from "node:crypto";
import fs from "node:fs";
import Module, { createRequire } from "node:module";
import path from "node:path";

import {
  createInterfaceFingerprint,
  moduleSpecifiersOf,
  readReactNativeInterface,
} from "@hot-updater/cli-tools";
import type {
  NativeFingerprintOptions,
  Platform,
} from "@hot-updater/plugin-core";

import { getConfig } from "./expoConfig";

const require = createRequire(import.meta.url);

/**
 * The app config fields the fingerprint reads. Older SDKs' types lack some,
 * and app.config.js can list a plugin as a function.
 */
type AppConfig = {
  jsEngine?: string;
  newArchEnabled?: boolean;
  ios?: { jsEngine?: string; newArchEnabled?: boolean };
  android?: { jsEngine?: string; newArchEnabled?: boolean };
  plugins?: unknown[];
};

// Hot Updater's own plugin writes the channel and the signing key, which
// don't change what JavaScript can call.
const HOT_UPDATER_PLUGINS = new Set([
  "@hot-updater/expo",
  "@hot-updater/expo/app.plugin.js",
]);

const sha256 = (data: string | Uint8Array) =>
  createHash("sha256").update(data).digest("hex");

const sortKeys = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(sortKeys)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => (a < b ? -1 : 1))
            .map(([key, entry]) => [key, sortKeys(entry)]),
        )
      : value;

/**
 * The folder of the installed package `name`, from the node_modules folders
 * above `cwd`.
 */
const packageDir = (cwd: string, name: string): string | null => {
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, "node_modules", name);
    if (fs.existsSync(path.join(candidate, "package.json"))) return candidate;
    if (path.dirname(dir) === dir) return null;
  }
};

const isLocal = (file: string) =>
  !file.split(path.sep).includes("node_modules");

/**
 * Every require seen while the app config was read, by the requiring file.
 * A module's `children` only lists what it loaded first, and app.config.js,
 * which Expo evaluates from a string, has no cached module at all.
 */
const requireEdges = new Map<string, Set<string>>();

type ModuleInternals = {
  prototype: { require: (this: Module, id: string) => unknown };
  _resolveFilename: (request: string, parent: Module) => string;
};

let recording = 0;
let unpatchedRequire: ModuleInternals["prototype"]["require"] | null = null;

/** Runs `read` with every require it makes recorded in `requireEdges`. */
export const recordRequires = async <T>(read: () => Promise<T>): Promise<T> => {
  const internals = Module as unknown as ModuleInternals;
  if (recording++ === 0) {
    const original = internals.prototype.require;
    unpatchedRequire = original;
    internals.prototype.require = function (this: Module, id: string) {
      const exports = original.call(this, id);
      try {
        const file = internals._resolveFilename(id, this);
        if (this.filename && path.isAbsolute(file)) {
          let edges = requireEdges.get(this.filename);
          if (!edges) requireEdges.set(this.filename, (edges = new Set()));
          edges.add(file);
        }
      } catch {
        // A built-in module or one that didn't resolve: nothing to hash.
      }
      return exports;
    };
  }
  try {
    return await read();
  } finally {
    if (--recording === 0 && unpatchedRequire) {
      internals.prototype.require = unpatchedRequire;
      unpatchedRequire = null;
    }
  }
};

const SOURCE_EXTENSIONS = new Set([
  ".js",
  ".cjs",
  ".mjs",
  ".jsx",
  ".ts",
  ".cts",
  ".mts",
  ".tsx",
]);

/**
 * The files `file`'s import declarations and `import()` calls name. ESM
 * imports don't go through `require`, so neither the module cache nor the
 * recorded requires see them.
 */
const staticImportsOf = (file: string): string[] => {
  if (!SOURCE_EXTENSIONS.has(path.extname(file))) return [];
  let specifiers: string[];
  try {
    specifiers = moduleSpecifiersOf(file, fs.readFileSync(file, "utf8"));
  } catch {
    return [];
  }
  return specifiers.flatMap((specifier) => {
    if (specifier.startsWith(".") || path.isAbsolute(specifier)) {
      const target = path.resolve(path.dirname(file), specifier);
      const found = [target, ...PLUGIN_EXTENSIONS.map((ext) => target + ext)]
        .filter((candidate) => fs.existsSync(candidate))
        .find((candidate) => fs.statSync(candidate).isFile());
      return found ? [fs.realpathSync(found)] : [];
    }
    if (specifier.startsWith("node:")) return [];
    const parts = specifier.split("/");
    const name = specifier.startsWith("@")
      ? parts.slice(0, 2).join("/")
      : parts[0]!;
    const dir = packageDir(path.dirname(file), name);
    if (dir === null) return []; // A built-in module.
    const real = fs.realpathSync(dir);
    // A registry package counts by its version.
    if (!isLocal(real)) return [path.join(real, "package.json")];
    const entry = esmEntry(real, `.${specifier.slice(name.length)}`);
    return [entry ?? path.join(real, "package.json")];
  });
};

/**
 * The file an `import` of `subpath` loads from the workspace package in
 * `dir`, as ESM resolves it: its `exports` under the `import` condition
 * first, else its `module` or `main` for the package itself.
 */
const esmEntry = (dir: string, subpath: string): string | null => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(dir, "package.json"), "utf8"),
  ) as { exports?: unknown; module?: string; main?: string };
  const pick = (target: unknown): string | null => {
    if (typeof target === "string") return target;
    if (Array.isArray(target)) {
      for (const entry of target) {
        const found = pick(entry);
        if (found) return found;
      }
      return null;
    }
    if (target && typeof target === "object") {
      const conditions = target as Record<string, unknown>;
      for (const condition of ["import", "node", "default", "require"]) {
        if (condition in conditions) {
          const found = pick(conditions[condition]);
          if (found) return found;
        }
      }
    }
    return null;
  };
  let relative: string | null = null;
  const { exports } = manifest;
  if (exports !== undefined) {
    const map =
      typeof exports === "string" ||
      Array.isArray(exports) ||
      !Object.keys(exports as object).some((key) => key.startsWith("."))
        ? { ".": exports }
        : (exports as Record<string, unknown>);
    relative = pick(map[subpath]);
  } else if (subpath === ".") {
    relative = manifest.module ?? manifest.main ?? "index.js";
  } else {
    relative = subpath;
  }
  if (relative === null) return null;
  const target = path.resolve(dir, relative);
  const found = [target, ...PLUGIN_EXTENSIONS.map((ext) => target + ext)].find(
    (candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile(),
  );
  return found ? fs.realpathSync(found) : null;
};

/** Every file `file` imports: required, cached first or not, or imported. */
const importsOf = (file: string): string[] => [
  ...(require.cache[file]?.children ?? []).map(({ filename }) => filename),
  ...(requireEdges.get(file) ?? []),
  ...staticImportsOf(file),
];

/**
 * What plugin code reaches from `entries`: the local files, followed
 * through what they import (sibling workspace packages included), and the
 * registry packages they import, by version. Expo requires config plugins,
 * so once the app config is read, the module cache and the recorded requires
 * hold each one's imports; a file nothing loaded counts by itself. The
 * project's own package.json, which app configs read for the version and
 * which changes with every release, is left out.
 */
const pluginGraph = (
  project: string,
  entries: readonly string[],
): { files: string[]; packages: string[] } => {
  const releaseManifest = path.join(project, "package.json");
  const files = new Set<string>();
  const packages = new Set<string>();
  const visit = (file: string) => {
    if (!isLocal(file)) {
      const owner = owningPackage(file);
      if (owner) packages.add(`${owner.name}@${owner.version}`);
      return;
    }
    if (files.has(file)) return;
    files.add(file);
    for (const imported of importsOf(file)) visit(imported);
  };
  for (const entry of entries) visit(entry);
  files.delete(releaseManifest);
  return { files: [...files].sort(), packages: [...packages].sort() };
};

/** A plugin graph's file contents, by their paths under `root`, and packages. */
const hashGraph = (
  root: string,
  graph: { files: readonly string[]; packages: readonly string[] },
): string =>
  `sha256:${sha256(
    [
      ...graph.files.map(
        (file) =>
          `${path.relative(root, file).split(path.sep).join("/")}\0${sha256(fs.readFileSync(file))}`,
      ),
      ...graph.packages,
    ].join("\0"),
  )}`;

// The extensions Expo tries for a local plugin path without one.
const PLUGIN_EXTENSIONS = [".js", ".cjs", ".mjs", ".ts", ".cts", ".mts"];

/** A local plugin path's file, by real path, as Expo resolves it. */
const resolvePluginFile = (cwd: string, plugin: string): string => {
  const target = path.resolve(cwd, plugin);
  try {
    return fs.realpathSync(require.resolve(target));
  } catch {
    for (const extension of PLUGIN_EXTENSIONS) {
      if (fs.existsSync(target + extension)) {
        return fs.realpathSync(target + extension);
      }
    }
    throw new Error(`Cannot resolve the config plugin ${plugin}.`);
  }
};

/** The installed package a file in node_modules belongs to. */
const owningPackage = (
  file: string,
): { name: string; version: string } | null => {
  for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
    const manifest = path.join(dir, "package.json");
    if (fs.existsSync(manifest)) {
      const { name, version } = JSON.parse(
        fs.readFileSync(manifest, "utf8"),
      ) as { name?: string; version?: string };
      if (name) return { name, version: version ?? "unknown" };
    }
    if (path.basename(dir) === "node_modules" || path.dirname(dir) === dir) {
      return null;
    }
  }
};

/**
 * The cached module a function plugin comes from: the one whose export it
 * is, such as `plugins: [require("./plugins/withNative")]`.
 */
const functionPluginModule = (plugin: unknown): string | null => {
  for (const [file, module] of Object.entries(require.cache)) {
    const exports = module?.exports as { default?: unknown } | undefined;
    if (exports === plugin || exports?.default === plugin) return file;
  }
  return null;
};

/** Where a plugin's code comes from, and the registry packages it reaches. */
interface PluginSource {
  source: string;
  packages: string[];
}

const fromGraph = (
  root: string,
  graph: { files: string[]; packages: string[] },
): PluginSource => ({
  source: hashGraph(root, graph),
  packages: graph.packages,
});

const fromPackage = (name: string, version: string): PluginSource => ({
  source: `${name}@${version}`,
  packages: [`${name}@${version}`],
});

const UNRESOLVED: PluginSource = { source: "unresolved", packages: [] };

/**
 * Where a config plugin's code comes from: the version of the registry
 * package that ships it, or, for a local file or a workspace package, the
 * contents of the file Expo loads and what it imports.
 */
const pluginSource = (cwd: string, plugin: string): PluginSource => {
  // Node caches modules by real path.
  const project = fs.realpathSync(cwd);
  if (plugin.startsWith(".") || path.isAbsolute(plugin)) {
    try {
      return fromGraph(
        project,
        pluginGraph(project, [resolvePluginFile(cwd, plugin)]),
      );
    } catch {
      return UNRESOLVED;
    }
  }
  const parts = plugin.split("/");
  const name = plugin.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
  const dir = packageDir(cwd, name);
  if (dir === null) return UNRESOLVED;
  const real = fs.realpathSync(dir);
  if (isLocal(real)) {
    // A workspace package: Expo loads its app.plugin file from the package
    // folder, whatever the package exports, else its main.
    try {
      const subpath = plugin.slice(name.length);
      const appPlugin = PLUGIN_EXTENSIONS.map((extension) =>
        path.join(real, `app.plugin${extension}`),
      ).find((candidate) => fs.existsSync(candidate));
      const entry = subpath
        ? require.resolve(plugin, { paths: [cwd] })
        : (appPlugin ?? require.resolve(name, { paths: [cwd] }));
      return fromGraph(real, pluginGraph(project, [fs.realpathSync(entry)]));
    } catch {
      return UNRESOLVED;
    }
  }
  const { version } = JSON.parse(
    fs.readFileSync(path.join(dir, "package.json"), "utf8"),
  ) as { version?: string };
  return version === undefined ? UNRESOLVED : fromPackage(name, version);
};

/**
 * A function plugin's source: the module whose export it is, such as
 * `plugins: [require("./plugins/withNative")]`, counted like a plugin named
 * by a string; or, written inline in app.config.js, its own source, with
 * what it can call from app.config.js's imports counted as `expo.config`.
 */
const functionPluginSource = (cwd: string, plugin: Function): PluginSource => {
  const project = fs.realpathSync(cwd);
  const file = functionPluginModule(plugin);
  if (file !== null) {
    if (isLocal(file)) return fromGraph(project, pluginGraph(project, [file]));
    const owner = owningPackage(file);
    if (owner) return fromPackage(owner.name, owner.version);
  }
  return { source: `sha256:${sha256(plugin.toString())}`, packages: [] };
};

/**
 * The settings an Expo app declares that decide its native build: the
 * JavaScript engine and the architecture, and the config plugins that
 * generate its native projects, with their options and code. They come from
 * the app config, so they are the same before and after `expo prebuild`.
 * `packages` are the registry packages that plugin code reaches, whose
 * patches change what prebuild generates.
 */
const collectExpoSettings = (
  cwd: string,
  exp: AppConfig,
  platform: Platform,
  configPath: string | null,
): { settings: Record<string, string>; packages: string[] } => {
  const settings: Record<string, string> = {};
  const packages = new Set<string>();
  const own = exp[platform];
  const jsEngine = own?.jsEngine ?? exp.jsEngine;
  if (jsEngine !== undefined) settings["expo.jsEngine"] = String(jsEngine);
  const newArchEnabled = own?.newArchEnabled ?? exp.newArchEnabled;
  if (newArchEnabled !== undefined) {
    settings["expo.newArchEnabled"] = String(newArchEnabled);
  }
  if (configPath) {
    // What app.config.js imports, which it can apply as plugins directly,
    // as `withPlugins(config, [withLocal])` does without listing them in
    // `plugins`. The app config file itself holds the version, so it
    // doesn't count.
    const project = fs.realpathSync(cwd);
    const graph = pluginGraph(project, importsOf(fs.realpathSync(configPath)));
    if (graph.files.length > 0 || graph.packages.length > 0) {
      settings["expo.config"] = hashGraph(project, graph);
    }
    for (const entry of graph.packages) packages.add(entry);
  }
  // Numbered after Hot Updater's own plugin is left out, so moving it
  // renumbers nothing.
  const plugins = (exp.plugins ?? [])
    .map((entry): unknown[] => (Array.isArray(entry) ? entry : [entry]))
    .filter(
      ([plugin]) =>
        !(typeof plugin === "string" && HOT_UPDATER_PLUGINS.has(plugin)),
    );
  plugins.forEach(([plugin, props], index) => {
    const found =
      typeof plugin === "string"
        ? pluginSource(cwd, plugin)
        : typeof plugin === "function"
          ? functionPluginSource(cwd, plugin)
          : null;
    if (!found) return;
    const name =
      typeof plugin === "string"
        ? plugin
        : (plugin as Function).name || "inline";
    settings[`expo.plugin[${index}]:${name}`] = JSON.stringify(
      sortKeys({ source: found.source, props: props ?? null }),
    );
    for (const entry of found.packages) packages.add(entry);
  });
  return {
    settings,
    packages: [...packages].map((entry) =>
      entry.slice(0, entry.lastIndexOf("@")),
    ),
  };
};

/** The settings `collectExpoSettings` reads, for one platform. */
export const readExpoSettings = (
  cwd: string,
  exp: AppConfig,
  platform: Platform,
  /** app.config.js or app.config.ts, when the app has one. */
  configPath: string | null = null,
): Record<string, string> =>
  collectExpoSettings(cwd, exp, platform, configPath).settings;

const autolinkingBin = (cwd: string) => {
  const expo = path.dirname(
    require.resolve("expo/package.json", { paths: [cwd] }),
  );
  return path.join(
    path.dirname(
      require.resolve("expo-modules-autolinking/package.json", {
        paths: [expo],
      }),
    ),
    "bin/expo-modules-autolinking.js",
  );
};

/**
 * The Expo adapter's native fingerprint: the native packages Expo's
 * autolinking links, and the settings the app config declares. Neither
 * needs the generated ios/ and android/ folders, so `fingerprint create`
 * before prebuild and the native build after it compute the same one.
 */
export const expoFingerprint = async (
  cwd: string,
  options: NativeFingerprintOptions,
) => {
  const { exp, dynamicConfigPath } = await recordRequires(() =>
    getConfig(cwd, { skipSDKVersionRequirement: true }),
  );
  const { settings, packages } = collectExpoSettings(
    cwd,
    exp as AppConfig,
    options.platform,
    dynamicConfigPath,
  );
  const read = (command: string[]) =>
    readReactNativeInterface({
      cwd,
      command: process.execPath,
      args: command,
      platform: options.platform,
      settings,
    });
  let nativeInterface;
  try {
    nativeInterface = await read([
      autolinkingBin(cwd),
      "react-native-config",
      "--platform",
      options.platform,
      "--json",
    ]);
  } catch (error) {
    // SDKs whose expo-modules-autolinking predates `react-native-config`
    // (before 1.11.2, such as SDK 50) autolink React Native packages with
    // React Native CLI, so its config lists them.
    try {
      nativeInterface = await read([
        path.join(
          path.dirname(
            require.resolve("react-native/package.json", { paths: [cwd] }),
          ),
          "cli.js",
        ),
        "config",
      ]);
    } catch {
      throw error;
    }
  }
  return createInterfaceFingerprint(cwd, options, {
    ...nativeInterface,
    // A patched config plugin changes what prebuild generates.
    patchedPackages: packages,
  });
};
