import { createNativeBuild } from "@/utils/native/createNativeBuild";
import { prepareNativeBuild } from "@/utils/native/prepareNativeBuild";
import { printBanner } from "@/utils/printBanner";
import * as p from "@clack/prompts";
import {
  createAndroidNativeBuild,
  enrichAndroidNativeBuildSchemeOptions,
} from "@hot-updater/android-helper";
import { createIosNativeBuild } from "@hot-updater/apple-helper";
import type { Platform } from "@hot-updater/core";
import { getCwd } from "@hot-updater/plugin-core";
import { ExecaError } from "execa";

export interface NativeBuildOptions {
  outputPath?: string;
  interactive: boolean;
  message?: string;
  platform?: Platform;
  scheme?: string;
}

export const nativeBuild = async (options: NativeBuildOptions) => {
  printBanner();
  const preparedConfig = await prepareNativeBuild(options);
  if (!preparedConfig) {
    p.log.error("preparing native build failed");
    return;
  }
  const { config, outputPath, platform, scheme } = preparedConfig;

  const cwd = getCwd();
  // TODO: store and upload in your mind
  const [buildPlugin /* storagePlugin, databasePlugin */] = await Promise.all([
    config.build({
      cwd,
    }),
    // config.storage({
    //   cwd,
    // }),
    // config.database({
    //   cwd,
    // }),
  ]);

  const cleanup = (e: unknown): never => {
    // await databasePlugin.onUnmount?.();
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

    const builder =
      platform === "android"
        ? () =>
            createAndroidNativeBuild({
              schemeConfig: enrichAndroidNativeBuildSchemeOptions(
                config.nativeBuild.android[scheme]!,
                {},
              ),
            })
        : () =>
            createIosNativeBuild({
              schemeConfig: config.nativeBuild.ios[scheme]!,
              outputPath,
            });

    const { buildDirectory, buildArtifactPath } = await createNativeBuild({
      buildPlugin,
      platform,
      outputPath,
      builder,
    });

    // spinner.start(`📦 Build Complete (${buildPlugin.name})`);

    taskRef.buildResult.buildArtifactPath = buildArtifactPath;
    taskRef.buildResult.buildDirectory = buildDirectory;

    if (taskRef.buildResult.stdout) {
      p.log.success(taskRef.buildResult.stdout);
    }
  } catch (e) {
    cleanup(e);
  }
};
