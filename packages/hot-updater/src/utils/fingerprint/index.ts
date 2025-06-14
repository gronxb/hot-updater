import fs from "fs";
import path from "path";
import * as p from "@clack/prompts";
import type { FingerprintSource } from "@expo/fingerprint";
import { createFingerprintAsync } from "@expo/fingerprint";
import { getCwd, loadConfig } from "@hot-updater/plugin-core";
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
      "The updateStrategy in hot-updater.config.ts is set to 'appVersion'. This command only works with 'fingerprint' strategy.",
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

export const createFingerprintJson = async () => {
  const FINGERPRINT_FILE_PATH = path.join(getCwd(), "fingerprint.json");
  const newFingerprint = await generateFingerprints();

  await fs.promises.writeFile(
    FINGERPRINT_FILE_PATH,
    JSON.stringify(newFingerprint, null, 2),
  );

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
