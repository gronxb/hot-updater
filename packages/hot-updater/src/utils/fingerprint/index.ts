import fs from "fs";
import path from "path";
import * as p from "@clack/prompts";
import type { FingerprintSource } from "@expo/fingerprint";
import { createFingerprintAsync } from "@expo/fingerprint";
import { type Platform, getCwd, loadConfig } from "@hot-updater/plugin-core";
import { setFingerprintHash } from "../setFingerprintHash";
import { processExtraSources } from "./processExtraSources";

export type FingerprintSources = {
  extraSources: string[];
  ignorePaths: string[];
};

export type FingerprintOptions = {
  platform: "ios" | "android";
  extraSources: string[];
  ignorePaths: string[];
  debug?: boolean;
};

export type FingerprintResult = {
  hash: string;
  sources: FingerprintSource[];
};

export function isFingerprintEquals(
  lhs?: FingerprintResult | null,
  rhs?: FingerprintResult | null,
): boolean;
export function isFingerprintEquals(
  lhs?: {
    android: FingerprintResult | null;
    ios: FingerprintResult | null;
  } | null,
  rhs?: {
    android: FingerprintResult | null;
    ios: FingerprintResult | null;
  } | null,
): boolean;
export function isFingerprintEquals(
  lhs?: Record<string, any> | null,
  rhs?: Record<string, any> | null,
): boolean {
  if (!lhs || !rhs) return false;
  if (isFingerprintResultsObject(lhs) && isFingerprintResultsObject(rhs)) {
    return (
      lhs.android.hash === rhs.android.hash && lhs.ios.hash === rhs.ios.hash
    );
  }
  if (!isFingerprintResultsObject(lhs) && !isFingerprintResultsObject(rhs)) {
    return lhs["hash"] === rhs["hash"];
  }

  return false;

  function isFingerprintResultsObject(
    result: Record<string, any>,
  ): result is { android: FingerprintResult; ios: FingerprintResult } {
    return (
      typeof result["android"] === "object" &&
      typeof result["ios"] === "object" &&
      !!result["android"]?.hash &&
      !!result["ios"]?.hash
    );
  }
}

/**
 * Calculates the fingerprint of the native parts project of the project.
 */
export async function nativeFingerprint(
  path: string,
  options: FingerprintOptions,
): Promise<FingerprintResult> {
  const platform = options.platform;
  return createFingerprintAsync(path, {
    platforms: [platform],
    ignorePaths: [
      "**/android/**/strings.xml",
      "**/ios/**/Info.plist",
      ...options.ignorePaths,
    ],
    extraSources: processExtraSources(
      options.extraSources,
      path,
      options.ignorePaths,
    ),
    debug: options.debug,
  });
}

const ensureFingerprintConfig = async () => {
  const config = await loadConfig(null);
  if (config.updateStrategy === "appVersion") {
    p.log.error(
      "The updateStrategy in hot-updater.config.ts is set to 'uappVersionu'. This command only works with 'fingerprint' strategy.",
    );
    process.exit(1);
  }
  return config.fingerprint;
};

export const generateFingerprints = async () => {
  const fingerprintConfig = await ensureFingerprintConfig();

  const [ios, android] = await Promise.all([
    nativeFingerprint(getCwd(), {
      platform: "ios",
      ...fingerprintConfig,
    }),
    nativeFingerprint(getCwd(), {
      platform: "android",
      ...fingerprintConfig,
    }),
  ]);
  return { ios, android };
};

export const generateFingerprint = async (platform: "ios" | "android") => {
  const fingerprintConfig = await ensureFingerprintConfig();

  return nativeFingerprint(getCwd(), {
    platform,
    ...fingerprintConfig,
  });
};

export const createAndInjectFingerprintFiles = async ({
  platform,
}: { platform?: Platform } = {}) => {
  const localFingerprint = await readLocalFingerprint();
  const FINGERPRINT_FILE_PATH = path.join(getCwd(), "fingerprint.json");
  const newFingerprint = await generateFingerprints();

  // replace whole file if and only if platform argument is none or fingerprint file doesn't exist
  if (!localFingerprint || !platform) {
    await fs.promises.writeFile(
      FINGERPRINT_FILE_PATH,
      JSON.stringify(newFingerprint, null, 2),
    );
    await setFingerprintHash("android", newFingerprint.android.hash);
    await setFingerprintHash("ios", newFingerprint.ios.hash);
  } else {
    // respect previous local fingerprint content first and replace the fingerprint of target platform.
    const nextFingerprints = {
      android: localFingerprint.android || newFingerprint.android,
      ios: localFingerprint.ios || newFingerprint.ios,
      [platform]: newFingerprint[platform],
    } satisfies Record<Platform, FingerprintResult>;

    await fs.promises.writeFile(
      FINGERPRINT_FILE_PATH,
      JSON.stringify(nextFingerprints, null, 2),
    );
    await setFingerprintHash(platform, newFingerprint[platform].hash);
  }

  return newFingerprint;
};

export const readLocalFingerprint = async (): Promise<{
  ios: FingerprintResult | null;
  android: FingerprintResult | null;
} | null> => {
  const FINGERPRINT_FILE_PATH = path.join(getCwd(), "fingerprint.json");
  try {
    const content = await fs.promises.readFile(FINGERPRINT_FILE_PATH, "utf-8");
    return JSON.parse(content);
  } catch {
    return null;
  }
};
