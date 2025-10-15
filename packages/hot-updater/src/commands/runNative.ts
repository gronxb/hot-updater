import * as p from "@clack/prompts";
import {
  type AndroidNativeRunOptions,
  runAndroid,
} from "@hot-updater/android-helper";
import { type IosNativeRunOptions, runIos } from "@hot-updater/apple-helper";
import type { Platform } from "@hot-updater/plugin-core";
import { ExecaError } from "execa";
import { prepareNativeBuild } from "@/utils/native/prepareNativeBuild";
import { printBanner } from "@/utils/printBanner";

const runNativeInternal = async <
  T extends AndroidNativeRunOptions | IosNativeRunOptions,
>({
  options,
  platform,
}: {
  options: T;
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
  const { config, scheme } = preparedConfig;

  const platformName = platform === "android" ? "Android" : "iOS";

  try {
    p.log.info(`📦 Running ${platformName} Started`);

    if (platform === "android") {
      await runAndroid({
        schemeConfig: config.nativeBuild.android[scheme]!,
        runOption: options as AndroidNativeRunOptions,
      });
    } else {
      await runIos({
        schemeConfig: config.nativeBuild.ios[scheme]!,
        runOption: options as IosNativeRunOptions,
      });
    }

    p.log.success(`📦 ${platformName} Run Complete`);
  } catch (e) {
    cleanup(e);
  }
};

const cleanup = (e: unknown): never => {
  if (e instanceof ExecaError) {
    console.error(e);
  } else if (e instanceof Error) {
    p.log.error(e.stack ?? e.message);
  } else {
    console.error(e);
  }
  process.exit(1);
};

export const runAndroidNative = async (options: AndroidNativeRunOptions) => {
  await runNativeInternal({ options, platform: "android" });
};

export const runIosNative = async (options: IosNativeRunOptions) => {
  await runNativeInternal({ options, platform: "ios" });
};
