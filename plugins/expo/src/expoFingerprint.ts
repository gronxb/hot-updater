import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import {
  createInterfaceFingerprint,
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
const HOT_UPDATER_PACKAGE = "@hot-updater/expo";

/**
 * A plugin option as JSON that keeps every value apart: each node is tagged
 * with its type, so values JSON drops or flattens (`undefined`, functions,
 * dates, regular expressions, big integers, maps, and sets) never meet an
 * ordinary value, and object keys are sorted.
 */
const canonical = (value: unknown): unknown => {
  if (value === null) return ["null"];
  if (value === undefined) return ["undefined"];
  switch (typeof value) {
    case "string":
      return ["string", value];
    case "number":
      return ["number", Object.is(value, -0) ? "-0" : String(value)];
    case "boolean":
      return ["boolean", value];
    case "bigint":
      return ["bigint", value.toString()];
    case "symbol":
      return ["symbol", value.toString()];
    case "function":
      return ["function", value.toString()];
  }
  if (Array.isArray(value)) return ["array", value.map(canonical)];
  if (value instanceof Date) return ["date", value.getTime()];
  if (value instanceof RegExp) return ["regexp", value.toString()];
  if (value instanceof Map) {
    return ["map", [...value].map((entry) => entry.map(canonical))];
  }
  if (value instanceof Set) return ["set", [...value].map(canonical)];
  return [
    "object",
    Object.entries(value as object)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([key, entry]) => [key, canonical(entry)]),
  ];
};

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
): { name: string; version: string; dir: string } | null => {
  for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
    const manifest = path.join(dir, "package.json");
    if (fs.existsSync(manifest)) {
      const { name, version } = JSON.parse(
        fs.readFileSync(manifest, "utf8"),
      ) as { name?: string; version?: string };
      if (name) return { name, version: version ?? "unknown", dir };
    }
    if (path.basename(dir) === "node_modules" || path.dirname(dir) === dir) {
      return null;
    }
  }
};

/**
 * The cached module a function plugin comes from: the one that exports it,
 * as `module.exports`, `default`, or a named export, such as
 * `plugins: [require("./plugins/withNative")]`.
 */
const functionPluginModule = (
  plugin: unknown,
): { file: string; exportName: string | null } | null => {
  const matches: { file: string; exportName: string | null }[] = [];
  for (const [file, module] of Object.entries(require.cache)) {
    const exports: unknown = module?.exports;
    if (exports === plugin) {
      matches.push({ file, exportName: null });
    } else if (exports !== null && typeof exports === "object") {
      const exportName = Object.entries(exports).find(
        ([, value]) => value === plugin,
      )?.[0];
      if (exportName !== undefined) {
        matches.push({
          file,
          exportName: exportName === "default" ? null : exportName,
        });
      }
    }
  }
  // A file that re-exports a plugin, such as a barrel with
  // `module.exports = require("registry-plugin")`, enters the cache before
  // the module it requires: prefer an installed package, then the module
  // loaded last.
  return (
    matches.findLast(({ file }) => !isLocal(file)) ?? matches.at(-1) ?? null
  );
}; /**
 * What the fingerprint records for a config plugin: its name, and where it
 * comes from. A registry package counts by its version, and its patches
 * through `package`. A plugin from the project or a workspace package counts
 * by its name only: like an edit to a bare app's native projects, an edit to
 * its code doesn't change the fingerprint, so bump `nativeVersion` (or list
 * it in `extraSources`) when it changes what JavaScript can call.
 */
interface PluginIdentity {
  name: string;
  source: string;
  package?: string;
}

const fromFile = (
  project: string,
  file: string,
  exportName: string | null = null,
): PluginIdentity => {
  // A package can ship several plugins, so the file and the export name
  // which one.
  const suffix = exportName === null ? "" : `#${exportName}`;
  if (!isLocal(file)) {
    const owner = owningPackage(file);
    if (owner) {
      const subpath = path.relative(owner.dir, file).split(path.sep).join("/");
      return {
        name: `${owner.name}/${subpath}${suffix}`,
        source: `${owner.name}@${owner.version}`,
        package: owner.name,
      };
    }
  }
  return {
    name: `${path.relative(project, file).split(path.sep).join("/")}${suffix}`,
    source: "local",
  };
};
const pluginIdentity = (cwd: string, plugin: unknown): PluginIdentity => {
  const project = fs.realpathSync(cwd);
  if (typeof plugin === "function") {
    const found = functionPluginModule(plugin);
    return found === null
      ? { name: plugin.name || "inline", source: "inline" }
      : fromFile(project, fs.realpathSync(found.file), found.exportName);
  }
  const name = String(plugin);
  if (name.startsWith(".") || path.isAbsolute(name)) {
    try {
      return fromFile(project, resolvePluginFile(cwd, name));
    } catch {
      return { name, source: "unresolved" };
    }
  }
  const parts = name.split("/");
  const packageName = name.startsWith("@")
    ? parts.slice(0, 2).join("/")
    : parts[0]!;
  const dir = packageDir(cwd, packageName);
  if (dir === null) return { name, source: "unresolved" };
  if (isLocal(fs.realpathSync(dir))) return { name, source: "workspace" };
  const manifest = JSON.parse(
    fs.readFileSync(path.join(dir, "package.json"), "utf8"),
  ) as { name?: string; version?: string };
  // Patches name the installed package, which an alias such as
  // `npm:expo-build-properties@...` installs under another name.
  const installed = manifest.name ?? packageName;
  return manifest.version === undefined
    ? { name, source: "unresolved" }
    : {
        name,
        source: `${installed}@${manifest.version}`,
        package: installed,
      };
};

/**
 * Whether a config plugin is Hot Updater's own, in any form an app config
 * names it: the package, a path into it, or its function.
 */
export const isHotUpdaterPlugin = (cwd: string, plugin: unknown): boolean => {
  let file: string | null = null;
  try {
    if (typeof plugin === "function") {
      file = functionPluginModule(plugin)?.file ?? null;
    } else if (typeof plugin === "string") {
      if (
        plugin === HOT_UPDATER_PACKAGE ||
        plugin.startsWith(`${HOT_UPDATER_PACKAGE}/`)
      ) {
        return true;
      }
      file =
        plugin.startsWith(".") || path.isAbsolute(plugin)
          ? resolvePluginFile(cwd, plugin)
          : require.resolve(plugin, { paths: [cwd] });
    }
  } catch {
    return false;
  }
  return (
    file !== null &&
    owningPackage(fs.realpathSync(file))?.name === HOT_UPDATER_PACKAGE
  );
};

/**
 * The settings an Expo app declares that decide its native build: the
 * JavaScript engine and the architecture, and the config plugins that
 * generate its native projects, with their options. They come from the app
 * config, so they are the same before and after `expo prebuild`. `packages`
 * are the registry packages that ship those plugins, whose patches change
 * what prebuild generates.
 */
const collectExpoSettings = (
  cwd: string,
  exp: AppConfig,
  platform: Platform,
): { settings: Record<string, string>; packages: string[] } => {
  const settings: Record<string, string> = {};
  const packages = new Set<string>();
  const own = exp[platform];
  // Expo builds with Hermes unless the app config says otherwise.
  settings["expo.jsEngine"] = String(own?.jsEngine ?? exp.jsEngine ?? "hermes");
  const newArchEnabled = own?.newArchEnabled ?? exp.newArchEnabled;
  if (newArchEnabled !== undefined) {
    settings["expo.newArchEnabled"] = String(newArchEnabled);
  }
  // Numbered after Hot Updater's own plugin is left out, so moving it
  // renumbers nothing.
  const plugins = (exp.plugins ?? [])
    .map((entry): unknown[] => (Array.isArray(entry) ? entry : [entry]))
    .filter(([plugin]) => !isHotUpdaterPlugin(cwd, plugin));
  plugins.forEach(([plugin, props], index) => {
    const identity = pluginIdentity(cwd, plugin);
    // Options can hold credentials, and fingerprint.json is committed, so
    // they are recorded by hash.
    settings[`expo.plugin[${index}]:${identity.name}`] = JSON.stringify({
      props:
        // An omitted argument, which Expo passes as `undefined`.
        props === undefined
          ? null
          : `sha256:${createHash("sha256")
              .update(JSON.stringify(canonical(props)))
              .digest("hex")}`,
      source: identity.source,
    });
    if (identity.package) packages.add(identity.package);
  });
  return { settings, packages: [...packages] };
};

/** The settings `collectExpoSettings` reads, for one platform. */
export const readExpoSettings = (
  cwd: string,
  exp: AppConfig,
  platform: Platform,
): Record<string, string> => collectExpoSettings(cwd, exp, platform).settings;

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
 * The commands that list the React Native packages a build links, in the
 * order to try. Expo's autolinking lists them, unless
 * `EXPO_USE_COMMUNITY_AUTOLINKING=1` makes the native templates link them
 * with React Native CLI, as Expo documents. SDKs whose
 * expo-modules-autolinking predates `react-native-config` (before 1.11.2,
 * such as SDK 50) also link them with React Native CLI.
 */
export const reactNativeConfigCommands = (
  cwd: string,
  platform: Platform,
  env: NodeJS.ProcessEnv = process.env,
): (() => string[])[] => {
  const community = () => [
    path.join(
      path.dirname(
        require.resolve("react-native/package.json", { paths: [cwd] }),
      ),
      "cli.js",
    ),
    "config",
  ];
  if (env["EXPO_USE_COMMUNITY_AUTOLINKING"] === "1") return [community];
  return [
    () => [
      autolinkingBin(cwd),
      "react-native-config",
      "--platform",
      platform,
      "--json",
    ],
    community,
  ];
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
  const { exp } = await getConfig(cwd, { skipSDKVersionRequirement: true });
  const { settings, packages } = collectExpoSettings(
    cwd,
    exp as AppConfig,
    options.platform,
  );
  const read = (command: () => string[]) =>
    readReactNativeInterface({
      cwd,
      command: process.execPath,
      args: command(),
      platform: options.platform,
      settings,
    });
  const [first, fallback] = reactNativeConfigCommands(cwd, options.platform);
  let nativeInterface;
  try {
    nativeInterface = await read(first!);
  } catch (error) {
    if (!fallback) throw error;
    try {
      nativeInterface = await read(fallback);
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
