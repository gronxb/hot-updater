import fs from "fs";
import path from "path";

import { getCwd, loadConfig } from "@hot-updater/cli-tools";
import type { NativeFingerprintProvider } from "@hot-updater/plugin-core";

import { getFingerprintHash, setFingerprintHash } from "../setFingerprintHash";
import {
  appendFingerprintExtraSources,
  isFingerprintEquals,
  type FingerprintOptions,
  type FingerprintResult,
} from "./common";

export * from "./common";
export * from "./diff";

const requireProvider = (provider?: NativeFingerprintProvider) => {
  if (!provider) {
    throw new Error(
      "The selected build integration does not provide native fingerprinting.",
    );
  }
  return provider;
};

export async function nativeFingerprint(
  projectPath: string,
  options: FingerprintOptions,
  provider?: NativeFingerprintProvider,
): Promise<FingerprintResult> {
  if (provider) return provider(options);
  const config = await loadConfig(null);
  const buildPlugin = await config.build({ cwd: projectPath });
  return requireProvider(buildPlugin.nativeBuild?.fingerprint)(options);
}

const resolveContext = async (additionalExtraSources?: readonly string[]) => {
  const cwd = getCwd();
  const config = await loadConfig(null);
  const buildPlugin = await config.build({ cwd });
  const integrationSources =
    (await buildPlugin.nativeBuild?.getFingerprintExtraSources?.()) ?? [];
  return {
    options: {
      ...config.fingerprint,
      extraSources: appendFingerprintExtraSources(
        appendFingerprintExtraSources(
          config.fingerprint.extraSources,
          integrationSources,
        ),
        additionalExtraSources ?? [],
      ),
    },
    provider: requireProvider(buildPlugin.nativeBuild?.fingerprint),
  };
};

export const generateFingerprints = async (
  additionalExtraSources?: readonly string[],
) => {
  const context = await resolveContext(additionalExtraSources);
  const [ios, android] = await Promise.all([
    context.provider({ platform: "ios", ...context.options }),
    context.provider({ platform: "android", ...context.options }),
  ]);
  return { ios, android };
};

export const generateFingerprint = async (platform: "ios" | "android") => {
  const context = await resolveContext();
  return context.provider({ platform, ...context.options });
};

export const createAndInjectFingerprintFiles = async ({
  platform,
}: {
  platform?: "ios" | "android";
} = {}) => {
  const local = await readLocalFingerprint();
  const fingerprint = await generateFingerprints();
  const androidPaths: string[] = [];
  const iosPaths: string[] = [];
  if (!local || !platform) {
    await createFingerprintJSON(fingerprint);
    androidPaths.push(
      ...(await setFingerprintHash("android", fingerprint.android.hash)).paths,
    );
    iosPaths.push(
      ...(await setFingerprintHash("ios", fingerprint.ios.hash)).paths,
    );
  } else {
    const next = {
      android: local.android || fingerprint.android,
      ios: local.ios || fingerprint.ios,
      [platform]: fingerprint[platform],
    } satisfies Record<"ios" | "android", FingerprintResult>;
    await createFingerprintJSON(next);
    const paths = (
      await setFingerprintHash(platform, fingerprint[platform].hash)
    ).paths;
    (platform === "android" ? androidPaths : iosPaths).push(...paths);
  }
  return { fingerprint, androidPaths, iosPaths };
};

/**
 * Brings fingerprint.json and each platform's native hash to `fingerprint`,
 * writing only what differs: what `fingerprint create` writes, without
 * rewriting a file whose content already matches. A platform without native
 * files is left alone. Returns what it wrote.
 */
export const syncFingerprintFiles = async (fingerprint: {
  ios: FingerprintResult;
  android: FingerprintResult;
}): Promise<{
  fingerprintJson: boolean;
  iosPaths: string[];
  androidPaths: string[];
}> => {
  const fingerprintJson = !isFingerprintEquals(
    await readLocalFingerprint(),
    fingerprint,
  );
  if (fingerprintJson) await createFingerprintJSON(fingerprint);
  const written = { ios: [] as string[], android: [] as string[] };
  for (const platform of ["ios", "android"] as const) {
    let current: string | null;
    try {
      current = (await getFingerprintHash(platform)).value;
    } catch {
      continue;
    }
    if (current === fingerprint[platform].hash) continue;
    written[platform] = (
      await setFingerprintHash(platform, fingerprint[platform].hash)
    ).paths;
  }
  return {
    fingerprintJson,
    iosPaths: written.ios,
    androidPaths: written.android,
  };
};

export const createFingerprintJSON = async (fingerprint: {
  ios: FingerprintResult;
  android: FingerprintResult;
}) => {
  await fs.promises.writeFile(
    path.join(getCwd(), "fingerprint.json"),
    JSON.stringify(fingerprint, null, 2),
  );
  return fingerprint;
};

export const readLocalFingerprint = async (): Promise<{
  ios: FingerprintResult | null;
  android: FingerprintResult | null;
} | null> => {
  try {
    return JSON.parse(
      await fs.promises.readFile(
        path.join(getCwd(), "fingerprint.json"),
        "utf-8",
      ),
    );
  } catch {
    return null;
  }
};
