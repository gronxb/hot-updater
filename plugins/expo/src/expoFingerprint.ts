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
  for (const [file, module] of Object.entries(require.cache)) {
    const exports: unknown = module?.exports;
    if (exports === plugin) return { file, exportName: null };
    if (exports !== null && typeof exports === "object") {
      const exportName = Object.entries(exports).find(
        ([, value]) => value === plugin,
      )?.[0];
      if (exportName !== undefined) {
        return {
          file,
          exportName: exportName === "default" ? null : exportName,
        };
      }
    }
  }
  return null;
};
/**
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
  const { version } = JSON.parse(
    fs.readFileSync(path.join(dir, "package.json"), "utf8"),
  ) as { version?: string };
  return version === undefined
    ? { name, source: "unresolved" }
    : { name, source: `${packageName}@${version}`, package: packageName };
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
  const jsEngine = own?.jsEngine ?? exp.jsEngine;
  if (jsEngine !== undefined) settings["expo.jsEngine"] = String(jsEngine);
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
    settings[`expo.plugin[${index}]:${identity.name}`] = JSON.stringify(
      sortKeys({ source: identity.source, props: props ?? null }),
    );
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
