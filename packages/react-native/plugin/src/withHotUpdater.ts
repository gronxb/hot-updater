import path from "node:path";
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
import {
  createFingerprintJSON,
  generateFingerprints,
  getPublicKeyFromPrivate,
  loadPrivateKey,
} from "hot-updater";
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

/**
 * Extract public key from private key in signing config
 */
const getPublicKeyFromConfig = async (
  signingConfig: { enabled?: boolean; privateKeyPath?: string } | undefined,
): Promise<string | null> => {
  if (!signingConfig?.enabled || !signingConfig?.privateKeyPath) {
    return null;
  }

  try {
    // Resolve private key path relative to project root
    const privateKeyPath = path.isAbsolute(signingConfig.privateKeyPath)
      ? signingConfig.privateKeyPath
      : path.resolve(process.cwd(), signingConfig.privateKeyPath);

    // Load private key and extract public key
    const privateKeyPEM = await loadPrivateKey(privateKeyPath);
    const publicKeyPEM = getPublicKeyFromPrivate(privateKeyPEM);

    return publicKeyPEM.trim();
  } catch (error) {
    throw new Error(
      `[hot-updater] Failed to extract public key: ${error instanceof Error ? error.message : String(error)}\n` +
        "Run 'npx hot-updater keys generate' to create signing keys",
    );
  }
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
    // Generate UTC timestamp at config time (prebuild time)
    const buildTimestamp = Date.now();

    let modifiedConfig = config;

    // === iOS: Add channel and fingerprint to Info.plist ===
    modifiedConfig = withInfoPlist(modifiedConfig, async (cfg) => {
      let fingerprintHash = null;
      const config = await loadConfig(null);
      if (config.updateStrategy !== "appVersion") {
        const fingerprint = await getFingerprint();
        fingerprintHash = fingerprint.ios.hash;
      }

      // Load public key if signing is enabled
      const publicKey = await getPublicKeyFromConfig(config.signing);

      cfg.modResults.HOT_UPDATER_CHANNEL = channel;
      // Add UTC build timestamp for timezone-safe minBundleId generation
      cfg.modResults.HOT_UPDATER_BUILD_TIMESTAMP = buildTimestamp;
      if (fingerprintHash) {
        cfg.modResults.HOT_UPDATER_FINGERPRINT_HASH = fingerprintHash;
      }
      if (publicKey) {
        cfg.modResults.HOT_UPDATER_PUBLIC_KEY = publicKey;
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

      // Load public key if signing is enabled
      const publicKey = await getPublicKeyFromConfig(config.signing);

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

      // Remove existing hot_updater_build_timestamp entry if it exists
      cfg.modResults.resources.string = cfg.modResults.resources.string.filter(
        (item) => !(item.$ && item.$.name === "hot_updater_build_timestamp"),
      );

      // Add UTC build timestamp for timezone-safe minBundleId generation
      cfg.modResults.resources.string.push({
        $: {
          name: "hot_updater_build_timestamp",
          moduleConfig: "true",
        } as {
          name: string;
          moduleConfig: string;
        },
        _: String(buildTimestamp),
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

      if (publicKey) {
        // Remove existing hot_updater_public_key entry if it exists
        cfg.modResults.resources.string =
          cfg.modResults.resources.string.filter(
            (item) => !(item.$ && item.$.name === "hot_updater_public_key"),
          );

        // Add the new hot_updater_public_key entry
        cfg.modResults.resources.string.push({
          $: {
            name: "hot_updater_public_key",
            moduleConfig: "true",
          } as {
            name: string;
            moduleConfig: string;
          },
          _: publicKey,
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
