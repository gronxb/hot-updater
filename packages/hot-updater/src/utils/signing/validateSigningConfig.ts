import crypto from "node:crypto";

import type { ConfigResponse } from "@hot-updater/cli-tools";
import type { Platform } from "@hot-updater/plugin-core";

import { AndroidConfigParser } from "../configParser/androidParser";
import { IosConfigParser } from "../configParser/iosParser";

const ANDROID_KEY = "hot_updater_public_key";
const IOS_KEY = "HOT_UPDATER_PUBLIC_KEY";

const parseRsaSpkiPublicKey = (publicKeyPem: string) => {
  const normalized = publicKeyPem.replaceAll("\\n", "\n").trim();
  if (
    !normalized.startsWith("-----BEGIN PUBLIC KEY-----") ||
    !normalized.endsWith("-----END PUBLIC KEY-----") ||
    normalized.includes("PRIVATE KEY")
  ) {
    throw new Error("not spki");
  }
  const publicKey = crypto.createPublicKey(normalized);
  if (
    publicKey.asymmetricKeyType !== "rsa" ||
    (publicKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
  ) {
    throw new Error("not rsa");
  }
  return publicKey;
};

export interface SigningConfigIssue {
  type: "error" | "warning";
  platform: "ios" | "android";
  code:
    | "MISSING_PUBLIC_KEY"
    | "NATIVE_FILES_NOT_FOUND"
    | "ORPHAN_PUBLIC_KEY"
    | "PUBLIC_KEY_MISMATCH";
  message: string;
  resolution: string;
}

export interface SigningValidationResult {
  isValid: boolean;
  signingEnabled: boolean;
  nativePublicKeys: {
    ios: { exists: boolean; paths: string[] };
    android: { exists: boolean; paths: string[] };
  };
  issues: SigningConfigIssue[];
}

/**
 * Validates signing configuration consistency between config file and native files.
 * Detects mismatches that would cause OTA updates to fail.
 */
export async function validateSigningConfig(
  config: ConfigResponse,
  options: {
    readonly expectedPublicKey?: string;
    readonly nativePublicKey?: string | null;
    readonly signingConfigSource?: "build-plugin";
    readonly platform?: Platform;
  } = {},
): Promise<SigningValidationResult> {
  const signingEnabled = config.signing !== undefined;

  const usesBuildPluginConfig = options.signingConfigSource === "build-plugin";
  const usesExternalNativeConfig =
    usesBuildPluginConfig || Object.hasOwn(options, "nativePublicKey");
  let iosExists = false;
  let androidExists = false;
  let iosResult: { value: string | null; paths: string[] } = {
    value: null,
    paths: [],
  };
  let androidResult = iosResult;
  if (!usesBuildPluginConfig) {
    const iosParser = new IosConfigParser(config.platform.ios.infoPlistPaths);
    const androidParser = new AndroidConfigParser(
      config.platform.android.androidManifestPaths ?? [],
    );
    [iosExists, androidExists] = await Promise.all([
      iosParser.exists(),
      androidParser.exists(),
    ]);
    [iosResult, androidResult] = await Promise.all([
      iosExists
        ? iosParser.get(IOS_KEY)
        : Promise.resolve({ value: null, paths: [] }),
      androidExists
        ? androidParser.get(ANDROID_KEY)
        : Promise.resolve({ value: null, paths: [] }),
    ]);
  }
  if (usesExternalNativeConfig && !iosExists && !androidExists) {
    const externalResult = {
      value: options.nativePublicKey ?? null,
      paths: [
        usesBuildPluginConfig
          ? "Build plugin native configuration"
          : "Expo app config",
      ],
    };
    iosResult = externalResult;
    androidResult = externalResult;
  }

  const issues: SigningConfigIssue[] = [];
  const validatesIos =
    options.platform === undefined || options.platform === "ios";
  const validatesAndroid =
    options.platform === undefined || options.platform === "android";

  const publicKeysMatch = (nativePublicKey: string) => {
    if (!options.expectedPublicKey) {
      return true;
    }

    try {
      const expected = parseRsaSpkiPublicKey(options.expectedPublicKey);
      const native = parseRsaSpkiPublicKey(nativePublicKey);
      return expected
        .export({ format: "der", type: "spki" })
        .equals(native.export({ format: "der", type: "spki" }));
    } catch {
      return false;
    }
  };

  if (signingEnabled) {
    // Signing enabled - check for missing public keys
    if (
      validatesIos &&
      !iosResult.value &&
      (iosExists || usesExternalNativeConfig)
    ) {
      issues.push({
        type: "error",
        platform: "ios",
        code: "MISSING_PUBLIC_KEY",
        message: usesBuildPluginConfig
          ? "Signing is enabled but the build plugin did not resolve a native public key"
          : usesExternalNativeConfig
            ? "Signing is enabled but @hot-updater/expo publicKeyPath is missing"
            : "Signing is enabled but HOT_UPDATER_PUBLIC_KEY is missing from Info.plist",
        resolution: usesBuildPluginConfig
          ? "Configure the build plugin to resolve the public key embedded in the native app, then rebuild the app if the key changes."
          : usesExternalNativeConfig
            ? "Run `npx hot-updater keys export-public --output <path>`, configure that path in the Expo app plugin, then rebuild your app."
            : "Run `npx hot-updater keys export-public` to add the public key, then rebuild your iOS app.",
      });
    }
    if (
      validatesAndroid &&
      !androidResult.value &&
      (androidExists || usesExternalNativeConfig)
    ) {
      issues.push({
        type: "error",
        platform: "android",
        code: "MISSING_PUBLIC_KEY",
        message: usesBuildPluginConfig
          ? "Signing is enabled but the build plugin did not resolve a native public key"
          : usesExternalNativeConfig
            ? "Signing is enabled but @hot-updater/expo publicKeyPath is missing"
            : "Signing is enabled but com.hotupdater.PUBLIC_KEY is missing from AndroidManifest.xml",
        resolution: usesBuildPluginConfig
          ? "Configure the build plugin to resolve the public key embedded in the native app, then rebuild the app if the key changes."
          : usesExternalNativeConfig
            ? "Run `npx hot-updater keys export-public --output <path>`, configure that path in the Expo app plugin, then rebuild your app."
            : "Run `npx hot-updater keys export-public` to add the public key, then rebuild your Android app.",
      });
    }
    if (
      iosResult.value &&
      validatesIos &&
      (iosExists || usesExternalNativeConfig) &&
      !publicKeysMatch(iosResult.value)
    ) {
      issues.push({
        type: "error",
        platform: "ios",
        code: "PUBLIC_KEY_MISMATCH",
        message:
          "The iOS public key does not match the configured bundle signer",
        resolution:
          "Export the configured public key, then rebuild and release the iOS app before deploying.",
      });
    }
    if (
      androidResult.value &&
      validatesAndroid &&
      (androidExists || usesExternalNativeConfig) &&
      !publicKeysMatch(androidResult.value)
    ) {
      issues.push({
        type: "error",
        platform: "android",
        code: "PUBLIC_KEY_MISMATCH",
        message:
          "The Android public key does not match the configured bundle signer",
        resolution:
          "Export the configured public key, then rebuild and release the Android app before deploying.",
      });
    }
  } else {
    // Signing disabled - check for orphan public keys
    if (iosResult.value) {
      issues.push({
        type: "warning",
        platform: "ios",
        code: "ORPHAN_PUBLIC_KEY",
        message: usesBuildPluginConfig
          ? "Signing is disabled but the build plugin resolved a native public key. The native app will reject unsigned updates."
          : "Signing is disabled but HOT_UPDATER_PUBLIC_KEY exists in Info.plist. This will cause OTA updates to be rejected.",
        resolution: usesBuildPluginConfig
          ? "Enable signing in hot-updater.config.ts, or remove the key from the native build configuration and rebuild the app."
          : "Run `npx hot-updater keys remove` to remove public keys, or enable signing in hot-updater.config.ts",
      });
    }
    if (androidResult.value) {
      issues.push({
        type: "warning",
        platform: "android",
        code: "ORPHAN_PUBLIC_KEY",
        message: usesBuildPluginConfig
          ? "Signing is disabled but the build plugin resolved a native public key. The native app will reject unsigned updates."
          : "Signing is disabled but com.hotupdater.PUBLIC_KEY exists in AndroidManifest.xml or legacy strings.xml. This will cause OTA updates to be rejected.",
        resolution: usesBuildPluginConfig
          ? "Enable signing in hot-updater.config.ts, or remove the key from the native build configuration and rebuild the app."
          : "Run `npx hot-updater keys remove` to remove public keys, or enable signing in hot-updater.config.ts",
      });
    }
  }

  return {
    isValid: issues.filter((i) => i.type === "error").length === 0,
    signingEnabled,
    nativePublicKeys: {
      ios: { exists: !!iosResult.value, paths: iosResult.paths },
      android: { exists: !!androidResult.value, paths: androidResult.paths },
    },
    issues,
  };
}
