import fs from "fs";
import path from "path";

import { getCwd } from "@hot-updater/cli-tools";
import type { Platform } from "@hot-updater/plugin-core";

import {
  ensureFingerprintConfig,
  type FingerprintFile,
  type FingerprintInputs,
  type FingerprintResult,
  getFingerprintInputs,
} from "./common";
import { writeFingerprintJsonIfChanged } from "./fingerprintJson";
import { nativeFingerprint } from "./nativeFingerprint";
import { assertNativeSdkEmbedsFingerprint } from "./nativeSdk";

export * from "./common";
export * from "./diff";
export * from "./nativeFingerprint";
export * from "./nativeSdk";
export * from "./recorded";

export const generateFingerprints = async (
  additionalExtraSources?: readonly string[],
): Promise<FingerprintFile> => {
  const fingerprintConfig = await ensureFingerprintConfig(
    additionalExtraSources,
  );

  const projectPath = getCwd();
  assertNativeSdkEmbedsFingerprint(projectPath);
  const [ios, android] = await Promise.all([
    nativeFingerprint(projectPath, {
      platform: "ios",
      ...fingerprintConfig,
    }),
    nativeFingerprint(projectPath, {
      platform: "android",
      ...fingerprintConfig,
    }),
  ]);
  return { ios, android, inputs: getFingerprintInputs(fingerprintConfig) };
};

export const generateFingerprint = async (platform: "ios" | "android") => {
  const fingerprintConfig = await ensureFingerprintConfig();

  return nativeFingerprint(getCwd(), {
    platform,
    ...fingerprintConfig,
  });
};

/**
 * Writes fingerprint.json, which native builds read to embed each platform's
 * hash. With `platform`, only that platform's fingerprint is replaced.
 */
export const createAndInjectFingerprintFiles = async ({
  platform,
}: {
  platform?: Platform;
} = {}) => {
  const localFingerprint = await readLocalFingerprint();
  const newFingerprint = await generateFingerprints();

  // replace whole file if and only if platform argument is none or fingerprint file doesn't exist
  await writeFingerprintJsonIfChanged(
    getCwd(),
    !localFingerprint || !platform
      ? newFingerprint
      : {
          android: localFingerprint.android || newFingerprint.android,
          ios: localFingerprint.ios || newFingerprint.ios,
          [platform]: newFingerprint[platform],
          inputs: newFingerprint.inputs,
        },
  );

  return { fingerprint: newFingerprint };
};

/**
 * Brings fingerprint.json to `fingerprint`, writing it only when the data it
 * records differs: what `fingerprint create` writes, without rewriting a
 * file that already matches. Returns whether it wrote.
 */
export const syncFingerprintFiles = async (
  fingerprint: FingerprintFile,
): Promise<{ fingerprintJson: boolean }> => ({
  fingerprintJson: await writeFingerprintJsonIfChanged(getCwd(), fingerprint),
});

/**
 * Writes fingerprint.json unless it already records `fingerprint`, and
 * returns `fingerprint`.
 */
export const createFingerprintJSON = async (fingerprint: FingerprintFile) => {
  await writeFingerprintJsonIfChanged(getCwd(), fingerprint);
  return fingerprint;
};

export const readLocalFingerprint = async (): Promise<{
  ios: FingerprintResult | null;
  android: FingerprintResult | null;
  inputs?: FingerprintInputs;
} | null> => {
  const FINGERPRINT_FILE_PATH = path.join(getCwd(), "fingerprint.json");
  try {
    const content = await fs.promises.readFile(FINGERPRINT_FILE_PATH, "utf-8");
    return JSON.parse(content);
  } catch {
    return null;
  }
};
