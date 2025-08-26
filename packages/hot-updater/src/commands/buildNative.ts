import { createNativeBuild } from "@/utils/native/createNativeBuild";
import { prepareNativeBuild } from "@/utils/native/prepareNativeBuild";
import { printBanner } from "@/utils/printBanner";
import * as p from "@clack/prompts";
import { buildAndroid } from "@hot-updater/android-helper";
import { buildIos } from "@hot-updater/apple-helper";
import { type NativeBuildOptions, getCwd } from "@hot-updater/plugin-core";
import { ExecaError } from "execa";

export const buildAndroidNative = async (options: NativeBuildOptions) => {
  printBanner();
  const preparedConfig = await prepareNativeBuild({
    ...options,
    platform: "android",
  });
  if (!preparedConfig) {
    p.log.error("preparing native build failed");
    return;
  }
  const { config, scheme, outputPath } = preparedConfig;

  const cwd = getCwd();
  const buildPlugin = await config.build({ cwd });

  try {
    p.log.info(`📦 Building Android (${buildPlugin.name}) Started`);
    await createNativeBuild({
      platform: "android",
      builder: () =>
        buildAndroid({
          schemeConfig: config.nativeBuild.android[scheme]!,
        }),
      buildPlugin,
      outputPath,
    });
    p.log.success(`📦 Android Build Complete (${buildPlugin.name})`);
  } catch (e) {
    catchError(e);
  }
};

export const buildIosNative = async (options: NativeBuildOptions) => {
  printBanner();
  const preparedConfig = await prepareNativeBuild({
    ...options,
    platform: "ios",
  });
  if (!preparedConfig) {
    p.log.error("preparing native build failed");
    return;
  }
  const { config, scheme, outputPath } = preparedConfig;

  const cwd = getCwd();
  const buildPlugin = await config.build({ cwd });

  try {
    p.log.info(`📦 Building iOS (${buildPlugin.name}) Started`);
    await createNativeBuild({
      platform: "ios",
      builder: () =>
        buildIos({
          schemeConfig: config.nativeBuild.ios[scheme]!,
        }),
      buildPlugin,
      outputPath,
    });
    p.log.success(`📦 iOS Build Complete (${buildPlugin.name})`);
  } catch (e) {
    catchError(e);
  }
};

const catchError = (e: unknown): never => {
  if (e instanceof ExecaError) {
    console.error(e);
  } else if (e instanceof Error) {
    p.log.error(e.stack ?? e.message);
  } else {
    console.error(e);
  }
  process.exit(1);
};
