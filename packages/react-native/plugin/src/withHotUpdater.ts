import { loadConfig } from "@hot-updater/cli-tools";
import type { ExpoConfig } from "expo/config";
import {
  createRunOncePlugin,
  withAppDelegate,
  withInfoPlist,
  withMainApplication,
  withPlugins,
  withStringsXml,
} from "expo/config-plugins";
import { createFingerprintJSON, generateFingerprints } from "hot-updater";
import pkg from "../../package.json";
import { transformAndroid, transformIOS } from "./transformers";

let fingerprintCache: Awaited<ReturnType<typeof generateFingerprints>> | null =
  null;

const getFingerprint = async () => {
  if (fingerprintCache) {
    return fingerprintCache;
  }

  fingerprintCache = await generateFingerprints();
  await createFingerprintJSON(fingerprintCache);
  return fingerprintCache;
};

// Type definitions
type HotUpdaterConfig = {
  channel?: string;
};

/**
 * Native code modifications - should only run once
 */
const withHotUpdaterNativeCode = (config: ExpoConfig) => {
  let modifiedConfig = config;

  // === iOS: Objective-C & Swift in AppDelegate ===
  modifiedConfig = withAppDelegate(modifiedConfig, (cfg) => {
    let contents = cfg.modResults.contents;

    contents = transformIOS(contents);

    cfg.modResults.contents = contents;
    return cfg;
  });

  // === Android: Kotlin in MainApplication ===
  modifiedConfig = withMainApplication(modifiedConfig, (cfg) => {
    let contents = cfg.modResults.contents;

    contents = transformAndroid(contents);

    cfg.modResults.contents = contents;
    return cfg;
  });

  return modifiedConfig;
};

/**
 * Configuration updates - should run every time
 */
const withHotUpdaterConfigAsync =
  (props: HotUpdaterConfig) => (config: ExpoConfig) => {
    const channel = props.channel || "production";

    let modifiedConfig = config;

    // === iOS: Add channel and fingerprint to Info.plist ===
    modifiedConfig = withInfoPlist(modifiedConfig, async (cfg) => {
      let fingerprintHash = null;
      const config = await loadConfig(null);
      if (config.updateStrategy !== "appVersion") {
        const fingerprint = await getFingerprint();
        fingerprintHash = fingerprint.ios.hash;
      }

      cfg.modResults.HOT_UPDATER_CHANNEL = channel;
      if (fingerprintHash) {
        cfg.modResults.HOT_UPDATER_FINGERPRINT_HASH = fingerprintHash;
      }
      return cfg;
    });

    // === Android: Add channel and fingerprint to strings.xml ===
    modifiedConfig = withStringsXml(modifiedConfig, async (cfg) => {
      let fingerprintHash = null;
      const config = await loadConfig(null);
      if (config.updateStrategy !== "appVersion") {
        const fingerprint = await getFingerprint();
        fingerprintHash = fingerprint.android.hash;
      }

      // Ensure resources object exists
      if (!cfg.modResults.resources) {
        cfg.modResults.resources = {};
      }
      if (!cfg.modResults.resources.string) {
        cfg.modResults.resources.string = [];
      }

      // Remove existing hot_updater_channel entry if it exists
      cfg.modResults.resources.string = cfg.modResults.resources.string.filter(
        (item) => !(item.$ && item.$.name === "hot_updater_channel"),
      );

      // Add the new hot_updater_channel entry
      cfg.modResults.resources.string.push({
        $: {
          name: "hot_updater_channel",
          moduleConfig: "true",
        } as {
          name: string;
          moduleConfig: string;
        },
        _: channel,
      });

      if (fingerprintHash) {
        // Remove existing hot_updater_fingerprint_hash entry if it exists
        cfg.modResults.resources.string =
          cfg.modResults.resources.string.filter(
            (item) =>
              !(item.$ && item.$.name === "hot_updater_fingerprint_hash"),
          );

        // Add the new hot_updater_fingerprint_hash entry
        cfg.modResults.resources.string.push({
          $: {
            name: "hot_updater_fingerprint_hash",
            moduleConfig: "true",
          } as {
            name: string;
            moduleConfig: string;
          },
          _: fingerprintHash,
        });
      }

      return cfg;
    });

    return modifiedConfig;
  };

/**
 * Main plugin that combines both native code (run once) and config (run always)
 */
const withHotUpdater = (config: ExpoConfig, props: HotUpdaterConfig = {}) => {
  // Apply plugins in order
  return withPlugins(config, [
    // Native code modifications - wrapped with createRunOncePlugin
    createRunOncePlugin(
      withHotUpdaterNativeCode,
      `${pkg.name}-native`,
      pkg.version,
    ),
    // Configuration updates - runs every time
    withHotUpdaterConfigAsync(props),
  ]);
};

// Export the main plugin
export default withHotUpdater;
