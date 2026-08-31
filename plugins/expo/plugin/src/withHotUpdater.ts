import type { ExpoConfig } from "expo/config";
import {
  XML,
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

let fingerprintCache: {
  readonly publicKeyPath: string | undefined;
  readonly value: Fingerprints;
} | null = null;

const getFingerprint = async (publicKeyPath: string | undefined) => {
  const cached = fingerprintCache;
  if (cached && cached.publicKeyPath === publicKeyPath) {
    return cached.value;
  }

  const { createFingerprintJSON, generateFingerprints } =
    await loadHotUpdater();
  const value = await generateFingerprints(
    publicKeyPath === undefined ? [] : [publicKeyPath],
  );
  fingerprintCache = { publicKeyPath, value };
  await createFingerprintJSON(value);
  return value;
};

/** Reads the native trust anchor configured by the Expo app. */
export const getPublicKeyFromConfig = async (
  publicKeyPath: string | undefined,
  projectRoot = process.cwd(),
): Promise<string | null> => {
  if (publicKeyPath === undefined) return null;

  try {
    const { readBundleSigningPublicKeyFile } = await loadCliTools();
    return (
      await readBundleSigningPublicKeyFile(publicKeyPath, { cwd: projectRoot })
    ).trim();
  } catch {
    throw new Error(
      "[hot-updater] Failed to load publicKeyPath for bundle signing.",
    );
  }
};

// Type definitions
type HotUpdaterConfig = {
  channel?: string;
  publicKeyPath?: string;
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
    let hotUpdaterConfigPromise:
      | ReturnType<Awaited<ReturnType<typeof loadCliTools>>["loadConfig"]>
      | undefined;
    const getHotUpdaterConfig = async () => {
      if (!hotUpdaterConfigPromise) {
        const { loadConfig } = await loadCliTools();
        hotUpdaterConfigPromise = loadConfig(null);
      }
      return hotUpdaterConfigPromise;
    };
    let publicKeyPromise: Promise<string | null> | undefined;
    const getPublicKey = async (projectRoot: string) => {
      if (!publicKeyPromise) {
        publicKeyPromise = getPublicKeyFromConfig(
          props.publicKeyPath,
          projectRoot,
        );
      }
      return publicKeyPromise;
    };

    let modifiedConfig = config;

    // === iOS: Add channel and fingerprint to Info.plist ===
    modifiedConfig = withInfoPlist(modifiedConfig, async (cfg) => {
      let fingerprintHash = null;
      const hotUpdaterConfig = await getHotUpdaterConfig();
      if (hotUpdaterConfig.updateStrategy !== "appVersion") {
        const fingerprint = await getFingerprint(props.publicKeyPath);
        fingerprintHash = fingerprint.ios.hash;
      }

      // Load public key if signing is enabled
      const publicKey = await getPublicKey(cfg.modRequest.projectRoot);

      cfg.modResults.HOT_UPDATER_CHANNEL = channel;
      if (fingerprintHash) {
        cfg.modResults.HOT_UPDATER_FINGERPRINT_HASH = fingerprintHash;
      }
      if (publicKey) {
        cfg.modResults.HOT_UPDATER_PUBLIC_KEY = publicKey;
      } else {
        delete cfg.modResults.HOT_UPDATER_PUBLIC_KEY;
      }
      return cfg;
    });

    // === Android: Add channel and fingerprint to AndroidManifest.xml ===
    modifiedConfig = withAndroidManifest(modifiedConfig, async (cfg) => {
      let fingerprintHash = null;
      const hotUpdaterConfig = await getHotUpdaterConfig();
      if (hotUpdaterConfig.updateStrategy !== "appVersion") {
        const fingerprint = await getFingerprint(props.publicKeyPath);
        fingerprintHash = fingerprint.android.hash;
      }

      // Load public key if signing is enabled
      const publicKey = await getPublicKey(cfg.modRequest.projectRoot);

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
          XML.escapeAndroidString(publicKey),
        );
      } else {
        removeAndroidMetaData(application, ANDROID_META_DATA_KEYS.publicKey);
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
