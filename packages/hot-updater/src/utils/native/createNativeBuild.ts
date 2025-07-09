import fs from "fs";
import path from "path";
import * as p from "@clack/prompts";
import type { Platform } from "@hot-updater/core";
import {
  type BuildPlugin,
  type ConfigInput,
  type NativeBuildArgs,
  type RequiredDeep,
  getCwd,
} from "@hot-updater/plugin-core";
import picocolors from "picocolors";
import { createAndroidNativeBuild } from "./android/createAndroidNativeBuild";
import { injectDefaultAndroidNativeBuildSchemeOptions } from "./android/utils/injectDefaultAndroidNativeBuildSchemeOptions";
import { createIosNativeBuild } from "./ios/createIosNativeBuild";
import { injectDefaultIosNativeBuildSchemeOptions } from "./ios/utils/injectDefaultIosNativeBuildSchemeOptions";

const createNativeBuildWithPlatform = async ({
  config,
  platform,
  scheme,
}: {
  platform: Platform;
  scheme: string;
  config: Required<NativeBuildArgs>;
}) => {
  switch (platform) {
    case "android":
      return createAndroidNativeBuild({
        schemeConfig: injectDefaultAndroidNativeBuildSchemeOptions(
          config.android[scheme]!,
        ),
      });
    case "ios":
      return createIosNativeBuild({
        schemeConfig: injectDefaultIosNativeBuildSchemeOptions(
          config.ios[scheme]!,
        ),
      });
    default:
      throw new Error(`Unexpected platform ${platform}`);
  }
};

export const createNativeBuild = async ({
  platform,
  config,
  scheme,
  outputPath,
  buildPlugin,
}: {
  platform: Platform;
  config: RequiredDeep<ConfigInput>;
  scheme: string;
  cwd?: string;
  outputPath: string;
  buildPlugin: BuildPlugin;
}): Promise<{ buildDirectory: string; buildArtifactPath: string }> => {
  buildPlugin.nativeBuild?.prebuild?.({ platform });

  const { buildArtifactPath, buildDirectory } =
    await createNativeBuildWithPlatform({
      platform,
      config: config.nativeBuild,
      scheme,
    });

  await buildPlugin.nativeBuild?.postbuild?.({ platform });

  await fs.promises.mkdir(outputPath, { recursive: true });

  p.log.success(
    `Artifact stored at ${picocolors.blueBright(path.relative(getCwd(), outputPath))}.`,
  );

  await fs.promises.rm(outputPath, {
    recursive: true,
    force: true,
  });
  await fs.promises.cp(buildDirectory, outputPath, {
    recursive: true,
  });

  return { buildArtifactPath, buildDirectory };
};
