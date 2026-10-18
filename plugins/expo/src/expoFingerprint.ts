import { createHash } from "node:crypto";
import fs from "node:fs";
import Module, { createRequire } from "node:module";
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

/** The local files `file` required, cached first or not. */
const localImports = (file: string): string[] =>
  [
    ...(require.cache[file]?.children ?? []).map(({ filename }) => filename),
    ...(requireEdges.get(file) ?? []),
  ].filter(isLocal);

/**
 * A plugin file and the local files it loads: every file outside
 * node_modules, sibling workspace packages included, since registry
 * packages count by version. Expo requires config plugins, so once the app
 * config is read, Node's module cache holds the files each one imported; a
 * file it hasn't loaded counts by itself.
 */
const pluginFiles = (entry: string): string[] => {
  const files = new Set<string>();
  const visit = (file: string) => {
    if (files.has(file)) return;
    files.add(file);
    for (const imported of localImports(file)) visit(imported);
  };
  visit(entry);
  return [...files].sort();
};

/** The contents of a plugin's files, by their paths under `root`. */
const hashPluginFiles = (root: string, entry: string): string =>
  `sha256:${sha256(
    pluginFiles(entry)
      .map(
        (file) =>
          `${path.relative(root, file).split(path.sep).join("/")}\0${sha256(fs.readFileSync(file))}`,
      )
      .join("\0"),
  )}`;

/**
 * Where a config plugin's code comes from: the version of the registry
 * package that ships it, or, for a local file or a workspace package, the
 * contents of the file Expo loads and the local files it imports.
 */
const pluginSource = (cwd: string, plugin: string): string => {
  // Node caches modules by real path.
  const project = fs.realpathSync(cwd);
  if (plugin.startsWith(".") || path.isAbsolute(plugin)) {
    try {
      return hashPluginFiles(
        project,
        require.resolve(path.resolve(cwd, plugin)),
      );
    } catch {
      return "unresolved";
    }
  }
  const parts = plugin.split("/");
  const name = plugin.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
  const dir = packageDir(cwd, name);
  if (dir === null) return "unresolved";
  const real = fs.realpathSync(dir);
  if (isLocal(real)) {
    // A workspace package: Expo loads its app.plugin.js, else its main.
    try {
      const subpath = plugin.slice(name.length);
      const entry = subpath
        ? require.resolve(plugin, { paths: [cwd] })
        : (() => {
            try {
              return require.resolve(`${name}/app.plugin.js`, {
                paths: [cwd],
              });
            } catch {
              return require.resolve(name, { paths: [cwd] });
            }
          })();
      return hashPluginFiles(real, fs.realpathSync(entry));
    } catch {
      return "unresolved";
    }
  }
  const { version } = JSON.parse(
    fs.readFileSync(path.join(dir, "package.json"), "utf8"),
  ) as { version?: string };
  return version === undefined ? "unresolved" : `${name}@${version}`;
};

/**
 * The local code app.config.js imported, and the code that imports: what it
 * can apply as plugins, as `withPlugins(config, [withLocal])` does without
 * listing them in `plugins`. JSON holds no plugin code, and package.json,
 * which app configs read for the version, changes with every release.
 */
const configImports = (configPath: string): string[] => {
  const files = new Set<string>();
  for (const file of localImports(configPath)) {
    for (const imported of pluginFiles(file)) {
      if (path.extname(imported) !== ".json") files.add(imported);
    }
  }
  return [...files].sort();
};

/**
 * The local module whose export is the function plugin `plugin`, such as
 * `plugins: [require("./plugins/withNative")]` in app.config.js.
 */
const functionPluginSource = (cwd: string, plugin: Function): string => {
  const project = fs.realpathSync(cwd);
  // Outside node_modules, a sibling workspace package included.
  for (const [file, module] of Object.entries(require.cache)) {
    const exports = module?.exports as { default?: unknown } | undefined;
    if (isLocal(file) && (exports === plugin || exports?.default === plugin)) {
      return hashPluginFiles(project, file);
    }
  }
  // Written inline in app.config.js: its source. What it calls from
  // app.config.js's imports counts as `expo.config`.
  return `sha256:${sha256(plugin.toString())}`;
};

/**
 * The settings an Expo app declares that decide its native build: the
 * JavaScript engine and the architecture, and the config plugins that
 * generate its native projects with their options. They come from the app
 * config, so they are the same before and after `expo prebuild`.
 */
export const readExpoSettings = (
  cwd: string,
  exp: AppConfig,
  platform: Platform,
  /** app.config.js or app.config.ts, when the app has one. */
  configPath: string | null = null,
): Record<string, string> => {
  const settings: Record<string, string> = {};
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
    .filter(
      ([plugin]) =>
        !(typeof plugin === "string" && HOT_UPDATER_PLUGINS.has(plugin)),
    );
  if (configPath) {
    const project = fs.realpathSync(cwd);
    const imports = configImports(fs.realpathSync(configPath));
    if (imports.length > 0) {
      settings["expo.config"] = `sha256:${sha256(
        imports
          .map(
            (file) =>
              `${path.relative(project, file).split(path.sep).join("/")}\0${sha256(fs.readFileSync(file))}`,
          )
          .join("\0"),
      )}`;
    }
  }
  plugins.forEach(([plugin, props], index) => {
    if (typeof plugin === "string") {
      settings[`expo.plugin[${index}]:${plugin}`] = JSON.stringify(
        sortKeys({ source: pluginSource(cwd, plugin), props: props ?? null }),
      );
    } else if (typeof plugin === "function") {
      settings[`expo.plugin[${index}]:${plugin.name || "inline"}`] =
        JSON.stringify(
          sortKeys({
            source: functionPluginSource(cwd, plugin),
            props: props ?? null,
          }),
        );
    }
  });
  return settings;
};

/** The packages the app config names as config plugins. */
const configPluginPackages = (exp: AppConfig): string[] =>
  (exp.plugins ?? []).flatMap((entry) => {
    const plugin = Array.isArray(entry) ? entry[0] : entry;
    if (
      typeof plugin !== "string" ||
      plugin.startsWith(".") ||
      path.isAbsolute(plugin)
    ) {
      return [];
    }
    const parts = plugin.split("/");
    return [plugin.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!];
  });

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
  const settings = readExpoSettings(
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
    patchedPackages: configPluginPackages(exp as AppConfig),
  });
};
