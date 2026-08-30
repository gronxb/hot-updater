import { createPrivateKey, createPublicKey } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "path";

import type { SigningConfig } from "@hot-updater/plugin-core";
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

const canonicalizeRsaSpkiPublicKey = (publicKeyPem: string): string => {
  const trimmed = publicKeyPem.trim();
  if (
    !trimmed.startsWith("-----BEGIN PUBLIC KEY-----") ||
    !trimmed.endsWith("-----END PUBLIC KEY-----") ||
    trimmed.includes("PRIVATE KEY")
  ) {
    throw new Error("not spki");
  }

  const publicKey = createPublicKey(trimmed);
  if (
    publicKey.asymmetricKeyType !== "rsa" ||
    (publicKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
  ) {
    throw new Error("not rsa");
  }

  return publicKey.export({ format: "pem", type: "spki" }).toString().trim();
};

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

/** Uses public-key-only configuration, or the v0 local key sources when omitted. */
export const getPublicKeyFromConfig = async (
  signingConfig: SigningConfig | undefined,
): Promise<string | null> => {
  if (
    !signingConfig ||
    ("enabled" in signingConfig && !signingConfig.enabled)
  ) {
    return null;
  }

  // Retain the v0 EAS key source only for local configs without an explicit pin.
  if ("enabled" in signingConfig && signingConfig.publicKeyPath === undefined) {
    const envPrivateKey = process.env.HOT_UPDATER_PRIVATE_KEY;
    if (envPrivateKey) {
      try {
        const pem = envPrivateKey.includes("-----BEGIN")
          ? envPrivateKey
          : await readFile(path.resolve(process.cwd(), envPrivateKey), "utf8");
        return canonicalizeRsaSpkiPublicKey(
          createPublicKey(createPrivateKey(pem))
            .export({ format: "pem", type: "spki" })
            .toString(),
        );
      } catch {
        // As in v0, try the configured local files if the environment source fails.
      }
    }
  }

  try {
    const { getBundleSigningPublicKey } = await loadCliTools();
    return (
      (
        await getBundleSigningPublicKey(signingConfig, { cwd: process.cwd() })
      )?.trim() ?? null
    );
  } catch {
    throw new Error(
      signingConfig.publicKeyPath !== undefined
        ? "[hot-updater] Failed to load publicKeyPath for bundle signing."
        : "[hot-updater] Failed to load public key for bundle signing.",
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
    const getPublicKey = async () => {
      if (!publicKeyPromise) {
        publicKeyPromise = getHotUpdaterConfig().then(($config) =>
          getPublicKeyFromConfig($config.signing),
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
        const fingerprint = await getFingerprint();
        fingerprintHash = fingerprint.ios.hash;
      }

      // Load public key if signing is enabled
      const publicKey = await getPublicKey();

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
        const fingerprint = await getFingerprint();
        fingerprintHash = fingerprint.android.hash;
      }

      // Load public key if signing is enabled
      const publicKey = await getPublicKey();

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
