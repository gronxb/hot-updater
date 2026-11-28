import {
  createInterfaceFingerprint,
  reactNativeConfigCommand,
  readReactNativeInterface,
} from "@hot-updater/cli-tools";
import type {
  NativeFingerprintOptions,
  Platform,
} from "@hot-updater/plugin-core";

import { getConfig } from "./expoConfig";

/** The app config fields that choose the JavaScript engine and architecture. */
type EngineConfig = {
  jsEngine?: string;
  newArchEnabled?: boolean;
  ios?: { jsEngine?: string; newArchEnabled?: boolean };
  android?: { jsEngine?: string; newArchEnabled?: boolean };
};

/**
 * The engine settings an Expo app declares, for one platform: the JavaScript
 * engine and the architecture. A bare app records them in
 * `android/gradle.properties`; an Expo app declares them in the app config,
 * which prebuild writes into the native projects.
 */
export const readExpoSettings = (
  exp: EngineConfig,
  platform: Platform,
): Record<string, string> => {
  const own = exp[platform];
  const settings: Record<string, string> = {
    // Expo builds with Hermes unless the app config says otherwise.
    "expo.jsEngine": String(own?.jsEngine ?? exp.jsEngine ?? "hermes"),
  };
  const newArchEnabled = own?.newArchEnabled ?? exp.newArchEnabled;
  if (newArchEnabled !== undefined) {
    settings["expo.newArchEnabled"] = String(newArchEnabled);
  }
  return settings;
};

/**
 * The Expo adapter's native fingerprint: the bare and Rock adapters' engine,
 * fed the native packages Expo's autolinking links and the engine settings
 * the app config declares. Neither needs the generated ios/ and android/
 * folders, so `fingerprint create` before prebuild and the native build
 * after it compute the same one.
 */
export const expoFingerprint = async (
  cwd: string,
  options: NativeFingerprintOptions,
) => {
  const { exp } = await getConfig(cwd, { skipSDKVersionRequirement: true });
  const settings = readExpoSettings(exp as EngineConfig, options.platform);
  const nativeInterface = await readReactNativeInterface({
    cwd,
    command: process.execPath,
    args: reactNativeConfigCommand(cwd, options.platform),
    platform: options.platform,
    settings,
  });
  return createInterfaceFingerprint(cwd, options, nativeInterface);
};
