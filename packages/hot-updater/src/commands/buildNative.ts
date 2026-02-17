import { buildAndroid } from "@hot-updater/android-helper";
import { buildIos } from "@hot-updater/apple-helper";
import { getCwd, p } from "@hot-updater/cli-tools";
import type { NativeBuildOptions, Platform } from "@hot-updater/plugin-core";
import { ExecaError } from "execa";
import { createNativeBuild } from "@/utils/native/createNativeBuild";
import { prepareNativeBuild } from "@/utils/native/prepareNativeBuild";
import { printBanner } from "@/utils/printBanner";

const buildNativeInternal = async ({
  options,
  platform,
}: {
  options: NativeBuildOptions;
  platform: Platform;
}) => {
  printBanner();
  const preparedConfig = await prepareNativeBuild({
    ...options,
    platform,
  });
  if (!preparedConfig) {
    p.log.error("preparing native build failed");
    return;
  }
  const { config, outputPath, androidSchemeConfig, iosSchemeConfig } =
    preparedConfig;

  const cwd = getCwd();
  const buildPlugin = await config.build({ cwd });

  const platformName = platform === "android" ? "Android" : "iOS";
  const builder =
    platform === "android"
      ? () =>
          buildAndroid({
            schemeConfig: androidSchemeConfig!,
          })
      : () =>
          buildIos({
            schemeConfig: iosSchemeConfig!,
          });

  try {
    p.log.info(`📦 Building ${platformName} (${buildPlugin.name}) Started`);
    await createNativeBuild({
      platform,
      builder,
      buildPlugin,
      outputPath,
    });
    p.log.success(`📦 ${platformName} Build Complete (${buildPlugin.name})`);
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

export const buildAndroidNative = async (options: NativeBuildOptions) => {
  await buildNativeInternal({ options, platform: "android" });
};

export const buildIosNative = async (options: NativeBuildOptions) => {
  await buildNativeInternal({ options, platform: "ios" });
};
