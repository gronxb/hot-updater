import type { NativeBuildOptions } from "@/commands/buildNative";
import { prepareNativeBuild } from "@/utils/native/prepareNativeBuild";
import { printBanner } from "@/utils/printBanner";
import * as p from "@clack/prompts";
import { runAndroid } from "@hot-updater/android-helper";
import { ExecaError } from "execa";

export interface NativeRunOptions extends NativeBuildOptions {
  device?: string | boolean;
}

export const runAndroidNative = async (
  options: Omit<NativeRunOptions, "platform">,
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

  try {
    p.log.info("📦 Running Android Started");

    await runAndroid({
      schemeConfig: config.nativeBuild.android[scheme]!,
      deviceOption: options.device,
      interactive: options.interactive,
    });

    p.log.success("📦 Android Run Complete");
  } catch (e) {
    cleanup(e);
  }
};

export const runIosNative = async (
  options: Omit<NativeRunOptions, "platform">,
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

  try {
    p.log.info("📦 Running iOS Started");

    // TODO: iOS run implementation needed
    p.log.info("iOS run not implemented yet");

    p.log.success("📦 iOS Run Complete");
  } catch (e) {
    cleanup(e);
  }
};
