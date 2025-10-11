import * as p from "@clack/prompts";
import {
  type AndroidNativeRunOptions,
  runAndroid,
} from "@hot-updater/android-helper";
import type { IosNativeRunOptions } from "@hot-updater/apple-helper";
import { ExecaError } from "execa";
import { prepareNativeBuild } from "@/utils/native/prepareNativeBuild";
import { printBanner } from "@/utils/printBanner";

export const runAndroidNative = async (options: AndroidNativeRunOptions) => {
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

  try {
    p.log.info("📦 Running Android Started");

    await runAndroid({
      schemeConfig: config.nativeBuild.android[scheme]!,
      runOption: options,
    });

    p.log.success("📦 Android Run Complete");
  } catch (e) {
    cleanup(e);
  }
};

export const runIosNative = async (options: IosNativeRunOptions) => {
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

  try {
    p.log.info("📦 Running iOS Started");

    const { runIos } = await import("@hot-updater/apple-helper");
    await runIos({
      schemeConfig: config.nativeBuild.ios[scheme]!,
      runOption: options,
    });

    p.log.success("📦 iOS Run Complete");
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
