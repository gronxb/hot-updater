import fs from "fs";
import path from "path";
import { createFingerprintAsync } from "@expo/fingerprint";
import { type Platform, getCwd } from "@hot-updater/plugin-core";
import { setFingerprintHash } from "../setFingerprintHash";
import {
  type FingerprintOptions,
  type FingerprintResult,
  ensureFingerprintConfig,
  getOtaFingerprintOptions,
} from "./common";

export * from "./common";
export * from "./diff";

/**
 * Calculates the fingerprint of the native parts project of the project.
 */
export async function nativeFingerprint(
  path: string,
  options: FingerprintOptions,
): Promise<FingerprintResult> {
  const platform = options.platform;
  return createFingerprintAsync(
    path,
    getOtaFingerprintOptions(platform, path, options),
  );
}

export const generateFingerprints = async () => {
  const fingerprintConfig = await ensureFingerprintConfig();

  const projectPath = getCwd();
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
  return { ios, android };
};

export const generateFingerprint = async (platform: "ios" | "android") => {
  const fingerprintConfig = await ensureFingerprintConfig();

  return nativeFingerprint(getCwd(), {
    platform,
    ...fingerprintConfig,
  });
};

export const createFingerprintJson = async ({
  platform,
}: { platform?: Platform } = {}) => {
  const localFingerprint = await readLocalFingerprint();
  const FINGERPRINT_FILE_PATH = path.join(getCwd(), "fingerprint.json");
  const newFingerprint = await generateFingerprints();

  if (!localFingerprint || !platform) {
    await fs.promises.writeFile(
      FINGERPRINT_FILE_PATH,
      JSON.stringify(newFingerprint, null, 2),
    );
  } else {
    const nextFingerprints = {
      android: localFingerprint.android || newFingerprint.android,
      ios: localFingerprint.ios || newFingerprint.ios,
      [platform]: newFingerprint[platform],
    } satisfies Record<Platform, FingerprintResult>;

    await fs.promises.writeFile(
      FINGERPRINT_FILE_PATH,
      JSON.stringify(nextFingerprints, null, 2),
    );
  }

  return {
    fingerprint: newFingerprint,
  };
};

export const createAndInjectFingerprintFiles = async ({
  platform,
}: { platform?: Platform } = {}) => {
  const localFingerprint = await readLocalFingerprint();
  const FINGERPRINT_FILE_PATH = path.join(getCwd(), "fingerprint.json");
  const newFingerprint = await generateFingerprints();

  const androidPaths: string[] = [];
  const iosPaths: string[] = [];
  // replace whole file if and only if platform argument is none or fingerprint file doesn't exist
  if (!localFingerprint || !platform) {
    await fs.promises.writeFile(
      FINGERPRINT_FILE_PATH,
      JSON.stringify(newFingerprint, null, 2),
    );
    const { paths: _androidPaths } = await setFingerprintHash(
      "android",
      newFingerprint.android.hash,
    );
    androidPaths.push(..._androidPaths);

    const { paths: _iosPaths } = await setFingerprintHash(
      "ios",
      newFingerprint.ios.hash,
    );
    iosPaths.push(..._iosPaths);
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
    const { paths: _platformPaths } = await setFingerprintHash(
      platform,
      newFingerprint[platform].hash,
    );
    switch (platform) {
      case "android":
        androidPaths.push(..._platformPaths);
        break;
      case "ios":
        iosPaths.push(..._platformPaths);
        break;
    }
  }

  return {
    fingerprint: newFingerprint,
    androidPaths,
    iosPaths,
  };
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
