import { prepareNativeBuild } from "@/utils/native/prepareNativeBuild";
import { printBanner } from "@/utils/printBanner";
import * as p from "@clack/prompts";
import { buildAndroid } from "@hot-updater/android-helper";
import { buildIos } from "@hot-updater/apple-helper";
import { type Platform, getCwd } from "@hot-updater/plugin-core";
import { ExecaError } from "execa";

export interface NativeBuildOptions {
  outputPath?: string;
  interactive: boolean;
  message?: string;
  platform?: Platform;
  scheme?: string;
}

export const buildAndroidNative = async (
  options: Omit<NativeBuildOptions, "platform">,
) => {
  printBanner();
  const preparedConfig = await prepareNativeBuild({
    ...options,
    platform: "android",
  });
  if (!preparedConfig) {
    p.log.error("preparing native build failed");
    return;
  }
  const { config, scheme } = preparedConfig;

  const cwd = getCwd();
  const buildPlugin = await config.build({ cwd });

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

  try {
    p.log.info(`📦 Building Android (${buildPlugin.name}) Started`);
    await buildPlugin.nativeBuild?.prebuild?.({ platform: "android" });
    await buildAndroid({
      schemeConfig: config.nativeBuild.android[scheme]!,
    });
    await buildPlugin.nativeBuild?.postbuild?.({ platform: "android" });
    p.log.success(`📦 Android Build Complete (${buildPlugin.name})`);
  } catch (e) {
    catchError(e);
  }
};

export const buildIosNative = async (
  options: Omit<NativeBuildOptions, "platform">,
) => {
  printBanner();
  const preparedConfig = await prepareNativeBuild({
    ...options,
    platform: "ios",
  });
  if (!preparedConfig) {
    p.log.error("preparing native build failed");
    return;
  }
  const { config, scheme } = preparedConfig;

  const cwd = getCwd();
  const buildPlugin = await config.build({ cwd });

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

  try {
    p.log.info(`📦 Building iOS (${buildPlugin.name}) Started`);
    await buildPlugin.nativeBuild?.prebuild?.({ platform: "ios" });
    await buildIos({
      schemeConfig: config.nativeBuild.ios[scheme]!,
    });
    await buildPlugin.nativeBuild?.postbuild?.({ platform: "ios" });
    p.log.success(`📦 iOS Build Complete (${buildPlugin.name})`);
  } catch (e) {
    catchError(e);
  }
};
