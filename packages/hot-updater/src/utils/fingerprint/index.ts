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
  isFingerprintEquals,
} from "./common";
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
  await createFingerprintJSON(
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
 * Brings fingerprint.json to `fingerprint`, writing it only when a hash or the
 * recorded inputs differ: what `fingerprint create` writes, without rewriting
 * a file that already matches. Returns whether it wrote.
 */
export const syncFingerprintFiles = async (
  fingerprint: FingerprintFile,
): Promise<{ fingerprintJson: boolean }> => {
  const local = await readLocalFingerprint();
  // A file from before engines were recorded gets the engine that computes
  // its unchanged hashes.
  const fingerprintJson =
    !isFingerprintEquals(local, fingerprint) ||
    JSON.stringify(local?.inputs) !== JSON.stringify(fingerprint.inputs) ||
    (["ios", "android"] as const).some(
      (platform) => local?.[platform]?.engine !== fingerprint[platform].engine,
    );
  if (fingerprintJson) await createFingerprintJSON(fingerprint);
  return { fingerprintJson };
};

export const createFingerprintJSON = async (fingerprint: FingerprintFile) => {
  const FINGERPRINT_FILE_PATH = path.join(getCwd(), "fingerprint.json");
  await fs.promises.writeFile(
    FINGERPRINT_FILE_PATH,
    JSON.stringify(fingerprint, null, 2),
  );
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
