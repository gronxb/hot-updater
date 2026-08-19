import { readFile } from "node:fs/promises";
import path from "path";

import type { ExpoConfig } from "expo/config";
import {
  createRunOncePlugin,
  withAndroidManifest,
  withAppDelegate,
  withInfoPlist,
  withMainApplication,
  withPlugins,
  withStringsXml,
} from "expo/config-plugins";

import pkg from "../../package.json";
import { transformAndroid, transformIOS } from "./transformers";

const loadCliTools = () => import("@hot-updater/cli-tools");
const loadHotUpdater = () => import("hot-updater");

const ANDROID_META_DATA_KEYS = {
  channel: "com.hotupdater.CHANNEL",
  fingerprintHash: "com.hotupdater.FINGERPRINT_HASH",
  publicKey: "com.hotupdater.PUBLIC_KEY",
} as const;

type AndroidMetaData = {
  $?: Record<string, string>;
};

type AndroidApplication = {
  "meta-data"?: AndroidMetaData | AndroidMetaData[];
};

const removeAndroidMetaData = (
  application: AndroidApplication,
  name: string,
) => {
  const metaData = application["meta-data"];
  if (!metaData) {
    return;
  }

  const filtered = (Array.isArray(metaData) ? metaData : [metaData]).filter(
    (item) => item?.$?.["android:name"] !== name,
  );

  if (filtered.length === 0) {
    delete application["meta-data"];
  } else {
    application["meta-data"] = filtered;
  }
};

const upsertAndroidMetaData = (
  application: AndroidApplication,
  name: string,
  value: string,
) => {
  removeAndroidMetaData(application, name);

  const metaData = Array.isArray(application["meta-data"])
    ? application["meta-data"]
    : application["meta-data"]
      ? [application["meta-data"]]
      : [];

  metaData.push({
    $: {
      "android:name": name,
      "android:value": value,
    },
  });
  application["meta-data"] = metaData;
};

type Fingerprints = Awaited<
  ReturnType<Awaited<ReturnType<typeof loadHotUpdater>>["generateFingerprints"]>
>;

let fingerprintCache: Fingerprints | null = null;

const getFingerprint = async () => {
  if (fingerprintCache) {
    return fingerprintCache;
  }

  const { createFingerprintJSON, generateFingerprints } =
    await loadHotUpdater();
  fingerprintCache = await generateFingerprints();
  await createFingerprintJSON(fingerprintCache);
  return fingerprintCache;
};

/**
 * Extract public key for embedding in native configs.
 * Supports multiple sources with priority order:
 * 1. HOT_UPDATER_PRIVATE_KEY environment variable
 * 2. Private key file (extract public key)
 * 3. Public key file (derived from privateKeyPath)
 * 4. Skip with warning (graceful fallback)
 */
export const getPublicKeyFromConfig = async (
  signingConfig: { enabled?: boolean; privateKeyPath?: string } | undefined,
): Promise<string | null> => {
  // If signing not enabled, no public key needed
  if (!signingConfig?.enabled) {
    return null;
  }

  const envPrivateKey = process.env.HOT_UPDATER_PRIVATE_KEY;
  if (envPrivateKey) {
    try {
      const { getPublicKeyFromPrivate, loadPrivateKey } =
        await loadHotUpdater();
      const envPrivateKeyPEM = envPrivateKey.includes("-----BEGIN")
        ? envPrivateKey
        : await loadPrivateKey(envPrivateKey);
      const publicKeyPEM = getPublicKeyFromPrivate(envPrivateKeyPEM);
      console.log(
        "[hot-updater] Using public key extracted from HOT_UPDATER_PRIVATE_KEY environment variable",
      );
      return publicKeyPEM.trim();
    } catch (error) {
      console.warn(
        "[hot-updater] WARNING: Failed to extract public key from HOT_UPDATER_PRIVATE_KEY:\n" +
          `${error instanceof Error ? error.message : String(error)}\n`,
      );
      // Continue to try other methods
    }
  }

  // If no privateKeyPath configured, can't proceed with file-based methods
  if (!signingConfig.privateKeyPath) {
    console.warn(
      "[hot-updater] WARNING: signing.enabled is true but no privateKeyPath configured.\n" +
        "Public key will not be embedded. Set HOT_UPDATER_PRIVATE_KEY environment variable or configure privateKeyPath.",
    );
    return null;
  }

  // Resolve paths
  const privateKeyPath = path.isAbsolute(signingConfig.privateKeyPath)
    ? signingConfig.privateKeyPath
    : path.resolve(process.cwd(), signingConfig.privateKeyPath);

  const publicKeyPath = privateKeyPath.replace(
    /private-key\.pem$/,
    "public-key.pem",
  );

  try {
    // Priority 2: Private key file (existing method)
    const { getPublicKeyFromPrivate, loadPrivateKey } = await loadHotUpdater();
    const privateKeyPEM = await loadPrivateKey(privateKeyPath);
    const publicKeyPEM = getPublicKeyFromPrivate(privateKeyPEM);
    console.log(`[hot-updater] Extracted public key from ${privateKeyPath}`);
    return publicKeyPEM.trim();
  } catch {
    try {
      // Priority 3: Public key file (fallback)
      const publicKeyPEM = await readFile(publicKeyPath, "utf-8");
      console.log(`[hot-updater] Using public key from ${publicKeyPath}`);
      return publicKeyPEM.trim();
    } catch {
      // Priority 4: All sources failed - throw error
      throw new Error(
        "[hot-updater] Failed to load public key for bundle signing.\n\n" +
          "Signing is enabled (signing.enabled: true) but no public key sources found.\n\n" +
          "For EAS builds, use EAS Secrets:\n" +
          '  eas env:create --name HOT_UPDATER_PRIVATE_KEY --value "$(cat keys/private-key.pem)"\n\n' +
          "Or add to eas.json:\n" +
          '  "env": { "HOT_UPDATER_PRIVATE_KEY": "-----BEGIN PRIVATE KEY-----\\n..." }\n\n' +
          "For local development:\n" +
          "  npx hot-updater keys generate\n\n" +
          `Searched locations:\n` +
          `  - HOT_UPDATER_PRIVATE_KEY environment variable\n` +
          `  - Private key file: ${privateKeyPath}\n` +
          `  - Public key file: ${publicKeyPath}\n`,
      );
    }
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

    let modifiedConfig = config;

    // === iOS: Add channel and fingerprint to Info.plist ===
    modifiedConfig = withInfoPlist(modifiedConfig, async (cfg) => {
      let fingerprintHash = null;
      const { loadConfig } = await loadCliTools();
      const config = await loadConfig(null);
      if (config.updateStrategy !== "appVersion") {
        const fingerprint = await getFingerprint();
        fingerprintHash = fingerprint.ios.hash;
      }

      // Load public key if signing is enabled
      const publicKey = await getPublicKeyFromConfig(config.signing);

      cfg.modResults.HOT_UPDATER_CHANNEL = channel;
      if (fingerprintHash) {
        cfg.modResults.HOT_UPDATER_FINGERPRINT_HASH = fingerprintHash;
      }
      if (publicKey) {
        cfg.modResults.HOT_UPDATER_PUBLIC_KEY = publicKey;
      }
      return cfg;
    });

    // === Android: Add channel and fingerprint to AndroidManifest.xml ===
    modifiedConfig = withAndroidManifest(modifiedConfig, async (cfg) => {
      let fingerprintHash = null;
      const { loadConfig } = await loadCliTools();
      const config = await loadConfig(null);
      if (config.updateStrategy !== "appVersion") {
        const fingerprint = await getFingerprint();
        fingerprintHash = fingerprint.android.hash;
      }

      // Load public key if signing is enabled
      const publicKey = await getPublicKeyFromConfig(config.signing);

      const application = cfg.modResults.manifest.application?.[0];
      if (!application) {
        return cfg;
      }

      upsertAndroidMetaData(
        application,
        ANDROID_META_DATA_KEYS.channel,
        channel,
      );

      if (fingerprintHash) {
        upsertAndroidMetaData(
          application,
          ANDROID_META_DATA_KEYS.fingerprintHash,
          fingerprintHash,
        );
      }

      if (publicKey) {
        upsertAndroidMetaData(
          application,
          ANDROID_META_DATA_KEYS.publicKey,
          publicKey,
        );
      }

      return cfg;
    });

    // Remove legacy Hot Updater string resources when prebuild reuses a tree.
    modifiedConfig = withStringsXml(modifiedConfig, (cfg) => {
      const strings = cfg.modResults.resources?.string;
      if (!strings) {
        return cfg;
      }

      cfg.modResults.resources.string = (
        Array.isArray(strings) ? strings : [strings]
      ).filter(
        (item) =>
          item.$?.name !== "hot_updater_channel" &&
          item.$?.name !== "hot_updater_fingerprint_hash" &&
          item.$?.name !== "hot_updater_public_key",
      );

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
