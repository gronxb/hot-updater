import { prepareNativeBuild } from "@/utils/native/prepareNativeBuild";
import { printBanner } from "@/utils/printBanner";
import * as p from "@clack/prompts";
import { runAndroid } from "@hot-updater/android-helper";
import { getCwd } from "@hot-updater/plugin-core";
import { ExecaError } from "execa";
import type { NativeBuildOptions } from "./buildNative";

export interface NativeRunOptions extends NativeBuildOptions {
  device?: string | boolean;
}

export const runNative = async (options: NativeRunOptions) => {
  printBanner();
  const preparedConfig = await prepareNativeBuild(options);
  if (!preparedConfig) {
    p.log.error("preparing native build failed");
    return;
  }
  const { config, outputPath, platform, scheme } = preparedConfig;

  const cwd = getCwd();
  const buildPlugin = await config.build({ cwd });

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
    const taskRef: {
      buildResult: {
        stdout: string | null;
        buildDirectory: string | null;
        buildArtifactPath: string | null;
      };
      storageUri: string | null;
    } = {
      buildResult: {
        buildArtifactPath: null,
        stdout: null,
        buildDirectory: null,
      },
      storageUri: null,
    };

    p.log.info(`📦 Building Native (${buildPlugin.name}) Started`);

    if (platform === "android") {
      await runAndroid({
        schemeConfig: config.nativeBuild.android[scheme]!,
        deviceOption: options.device,
        interactive: options.interactive,
      });
    } else if (platform === "ios") {
    }

    // taskRef.buildResult.buildArtifactPath = buildArtifactPath;
    // taskRef.buildResult.buildDirectory = buildDirectory;

    if (taskRef.buildResult.stdout) {
      p.log.info(taskRef.buildResult.stdout);
    }

    p.log.success(`📦 Build Complete (${buildPlugin.name})`);
  } catch (e) {
    cleanup(e);
  }
};
