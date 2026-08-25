import crypto from "node:crypto";

import type { ConfigResponse } from "@hot-updater/cli-tools";

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
  if (publicKey.asymmetricKeyType !== "rsa") {
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
  options: { readonly expectedPublicKey?: string } = {},
): Promise<SigningValidationResult> {
  const signingEnabled = config.signing?.enabled ?? false;

  const iosParser = new IosConfigParser(config.platform.ios.infoPlistPaths);
  const androidParser = new AndroidConfigParser(
    config.platform.android.androidManifestPaths ?? [],
  );

  const [iosExists, androidExists] = await Promise.all([
    iosParser.exists(),
    androidParser.exists(),
  ]);

  const [iosResult, androidResult] = await Promise.all([
    iosExists
      ? iosParser.get(IOS_KEY)
      : Promise.resolve({ value: null, paths: [] }),
    androidExists
      ? androidParser.get(ANDROID_KEY)
      : Promise.resolve({ value: null, paths: [] }),
  ]);

  const issues: SigningConfigIssue[] = [];

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
    if (!iosResult.value && iosExists) {
      issues.push({
        type: "error",
        platform: "ios",
        code: "MISSING_PUBLIC_KEY",
        message:
          "Signing is enabled but HOT_UPDATER_PUBLIC_KEY is missing from Info.plist",
        resolution:
          "Run `npx hot-updater keys export-public` to add the public key, then rebuild your iOS app.",
      });
    }
    if (!androidResult.value && androidExists) {
      issues.push({
        type: "error",
        platform: "android",
        code: "MISSING_PUBLIC_KEY",
        message:
          "Signing is enabled but com.hotupdater.PUBLIC_KEY is missing from AndroidManifest.xml",
        resolution:
          "Run `npx hot-updater keys export-public` to add the public key, then rebuild your Android app.",
      });
    }
    if (iosResult.value && iosExists && !publicKeysMatch(iosResult.value)) {
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
      androidExists &&
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
        message:
          "Signing is disabled but HOT_UPDATER_PUBLIC_KEY exists in Info.plist. This will cause OTA updates to be rejected.",
        resolution:
          "Run `npx hot-updater keys remove` to remove public keys, or enable signing in hot-updater.config.ts",
      });
    }
    if (androidResult.value) {
      issues.push({
        type: "warning",
        platform: "android",
        code: "ORPHAN_PUBLIC_KEY",
        message:
          "Signing is disabled but com.hotupdater.PUBLIC_KEY exists in AndroidManifest.xml or legacy strings.xml. This will cause OTA updates to be rejected.",
        resolution:
          "Run `npx hot-updater keys remove` to remove public keys, or enable signing in hot-updater.config.ts",
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
