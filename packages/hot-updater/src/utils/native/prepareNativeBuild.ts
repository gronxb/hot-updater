import path from "path";
import * as p from "@clack/prompts";
import {
  type ConfigResponse,
  type NativeBuildOptions,
  type Platform,
  getCwd,
  loadConfig,
} from "@hot-updater/plugin-core";
import picocolors from "picocolors";

import { getPlatform } from "@/prompts/getPlatform";
import {
  createAndInjectFingerprintFiles,
  isFingerprintEquals,
  readLocalFingerprint,
} from "@/utils/fingerprint";
import { getDefaultOutputPath } from "@/utils/output/getDefaultOutputPath";
import { getNativeAppVersion } from "@/utils/version/getNativeAppVersion";

export async function prepareNativeBuild(options: NativeBuildOptions): Promise<{
  outputPath: string;
  config: ConfigResponse;
  platform: Platform;
  scheme: string;
} | null> {
  const cwd = getCwd();

  if (!options.scheme && !options.interactive) {
    p.log.error("required option '-s, --scheme <scheme>' not specified");
    return null;
  }

  const platform: Platform | null | symbol =
    options.platform ??
    (options.interactive
      ? await getPlatform("Which platform do you want to deploy?")
      : null);

  if (p.isCancel(platform)) {
    return null;
  }

  if (!platform) {
    p.log.error(
      "Platform not found. -p <ios | android> or --platform <ios | android>",
    );
    return null;
  }

  // TODO: handle channel or determine channel is not related in this context
  const config = await loadConfig({ platform, channel: "DUMMY" });
  if (!config) {
    p.log.error("No config found. Please run `hot-updater init` first.");
    return null;
  }

  const availableSchemes: string[] = Object.keys(
    config.nativeBuild[platform],
  ).sort();

  if (!availableSchemes.length) {
    // TODO: add documentation links
    p.log.error(`configure your native build schemes for ${platform} first.`);
    return null;
  }

  const scheme =
    options.scheme ??
    (await p.select({
      message: "Which scheme do you use to build?",
      options: availableSchemes.map((s) => ({ label: s, value: s })),
    }));

  if (p.isCancel(scheme)) {
    return null;
  }

  if (!(scheme in config.nativeBuild[platform])) {
    p.log.error(
      `scheme ${picocolors.blueBright(options.scheme)} is not in predefined schemes [${picocolors.blueBright(availableSchemes.join(", "))}]`,
    );
    return null;
  }

  const target: {
    appVersion: string | null;
    fingerprintHash: string | null;
  } = {
    appVersion: null,
    fingerprintHash: null,
  };

  // calculate fingerprint of the current file state in the native platform directory

  if (config.updateStrategy === "fingerprint") {
    const s = p.spinner();
    const localFingerprint = (await readLocalFingerprint())?.[platform];
    if (!localFingerprint) {
      p.log.warn(
        `Resolving fingerprint for ${platform} failed. Building native will generate it.`,
      );
    }
    s.start(`Fingerprinting (${platform})`);

    // generate fingerprint.json automatically
    const generatedFingerprint = (await createAndInjectFingerprintFiles())
      .fingerprint[platform];

    s.stop(`Fingerprint(${platform}): ${generatedFingerprint.hash}`);

    if (!isFingerprintEquals(localFingerprint, generatedFingerprint)) {
      p.log.info(
        `${picocolors.blue(`fingerprint.json, ${platform} fingerprint config files`)} have been changed.`,
      );
    }
    target.fingerprintHash = generatedFingerprint.hash;
  } else if (config.updateStrategy === "appVersion") {
    const s = p.spinner();
    s.start(`Get native app version (${platform})`);

    const appVersion = await getNativeAppVersion(platform);

    s.stop(`App Version(${platform}): ${appVersion}`);

    target.appVersion = appVersion;

    if (!target.appVersion) {
      p.log.error(`Failed to retrieve native app version of ${platform}`);
      return null;
    }
  }

  const artifactResultStorePath =
    options.outputPath ??
    path.join(getDefaultOutputPath(), "build", platform, scheme);

  const resolvedOutputPath = path.isAbsolute(artifactResultStorePath)
    ? artifactResultStorePath
    : path.join(cwd, artifactResultStorePath);

  return { outputPath: resolvedOutputPath, config, platform, scheme };
}
