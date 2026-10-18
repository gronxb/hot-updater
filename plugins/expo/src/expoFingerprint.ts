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

/** The installed version of `name`, from the node_modules folders above `cwd`. */
const packageVersion = (cwd: string, name: string): string | null => {
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    const manifest = path.join(dir, "node_modules", name, "package.json");
    if (fs.existsSync(manifest)) {
      const { version } = JSON.parse(fs.readFileSync(manifest, "utf8")) as {
        version?: string;
      };
      return version ?? null;
    }
    if (path.dirname(dir) === dir) return null;
  }
};

/**
 * Where a config plugin's code comes from: the version of the package that
 * ships it, or the contents of a local plugin file.
 */
const pluginSource = (cwd: string, plugin: string): string => {
  if (plugin.startsWith(".") || path.isAbsolute(plugin)) {
    try {
      const file = require.resolve(path.resolve(cwd, plugin));
      return `sha256:${sha256(fs.readFileSync(file))}`;
    } catch {
      return "unresolved";
    }
  }
  const parts = plugin.split("/");
  const name = plugin.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
  const version = packageVersion(cwd, name);
  return version === null ? "unresolved" : `${name}@${version}`;
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
): Record<string, string> => {
  const settings: Record<string, string> = {};
  const own = exp[platform];
  const jsEngine = own?.jsEngine ?? exp.jsEngine;
  if (jsEngine !== undefined) settings["expo.jsEngine"] = String(jsEngine);
  const newArchEnabled = own?.newArchEnabled ?? exp.newArchEnabled;
  if (newArchEnabled !== undefined) {
    settings["expo.newArchEnabled"] = String(newArchEnabled);
  }
  (exp.plugins ?? []).forEach((entry, index) => {
    const [plugin, props]: unknown[] = Array.isArray(entry)
      ? entry
      : [entry, undefined];
    if (typeof plugin === "string") {
      if (HOT_UPDATER_PLUGINS.has(plugin)) return;
      settings[`expo.plugin[${index}]:${plugin}`] = JSON.stringify(
        sortKeys({ source: pluginSource(cwd, plugin), props: props ?? null }),
      );
    } else if (typeof plugin === "function") {
      // A plugin written inline in app.config.js.
      settings[`expo.plugin[${index}]:${plugin.name || "inline"}`] =
        JSON.stringify(
          sortKeys({
            source: `sha256:${sha256(plugin.toString())}`,
            props: props ?? null,
          }),
        );
    }
  });
  return settings;
};

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
  const { exp } = await getConfig(cwd, { skipSDKVersionRequirement: true });
  return createInterfaceFingerprint(
    cwd,
    options,
    await readReactNativeInterface({
      cwd,
      command: process.execPath,
      args: [
        autolinkingBin(cwd),
        "react-native-config",
        "--platform",
        options.platform,
        "--json",
      ],
      platform: options.platform,
      settings: readExpoSettings(cwd, exp as AppConfig, options.platform),
    }),
  );
};
