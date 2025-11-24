import type { ConfigResponse } from "@hot-updater/cli-tools";
import { AndroidConfigParser } from "@/utils/configParser/androidParser";
import { IosConfigParser } from "@/utils/configParser/iosParser";

const ANDROID_KEY = "hot_updater_public_key";
const IOS_KEY = "HOT_UPDATER_PUBLIC_KEY";

export interface SigningConfigIssue {
  type: "error" | "warning";
  platform: "ios" | "android";
  code:
    | "MISSING_PUBLIC_KEY"
    | "ORPHAN_PUBLIC_KEY"
    | "NATIVE_FILES_NOT_FOUND";
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
): Promise<SigningValidationResult> {
  const signingEnabled = config.signing?.enabled ?? false;

  const iosParser = new IosConfigParser(config.platform.ios.infoPlistPaths);
  const androidParser = new AndroidConfigParser(
    config.platform.android.stringResourcePaths,
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

  if (signingEnabled) {
    // Signing enabled - check for missing public keys
    if (!iosResult.value && iosExists) {
      issues.push({
        type: "error",
        platform: "ios",
        code: "MISSING_PUBLIC_KEY",
        message:
          "Signing is enabled but HOT_UPDATER_PUBLIC_KEY is missing from Info.plist",
        resolution: "Run `npx hot-updater keys export-public` to add the public key, then rebuild your iOS app.",
      });
    }
    if (!androidResult.value && androidExists) {
      issues.push({
        type: "error",
        platform: "android",
        code: "MISSING_PUBLIC_KEY",
        message:
          "Signing is enabled but hot_updater_public_key is missing from strings.xml",
        resolution: "Run `npx hot-updater keys export-public` to add the public key, then rebuild your Android app.",
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
        resolution: "Run `npx hot-updater keys remove` to remove public keys, or enable signing in hot-updater.config.ts",
      });
    }
    if (androidResult.value) {
      issues.push({
        type: "warning",
        platform: "android",
        code: "ORPHAN_PUBLIC_KEY",
        message:
          "Signing is disabled but hot_updater_public_key exists in strings.xml. This will cause OTA updates to be rejected.",
        resolution: "Run `npx hot-updater keys remove` to remove public keys, or enable signing in hot-updater.config.ts",
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
