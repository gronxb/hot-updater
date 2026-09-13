import fs from "fs";
import path from "path";

import { getCwd, loadConfig } from "@hot-updater/cli-tools";
import type { NativeFingerprintProvider } from "@hot-updater/plugin-core";

import { setFingerprintHash } from "../setFingerprintHash";
import {
  appendFingerprintExtraSources,
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
