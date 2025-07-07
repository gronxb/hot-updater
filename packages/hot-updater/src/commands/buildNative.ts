import { createNativeBuild } from "@/utils/native/createNativeBuild";
import { prepareNativeBuild } from "@/utils/native/prepareNativeBuild";
import * as p from "@clack/prompts";
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

    await p.tasks([
      {
        title: `📦 Building Native (${buildPlugin.name})`,
        task: async () => {
          const { buildDirectory, buildArtifactPath } = await createNativeBuild(
            {
              buildPlugin,
              platform,
              config,
              scheme,
              outputPath,
              cwd,
            },
          );
          taskRef.buildResult.buildArtifactPath = buildArtifactPath;
          taskRef.buildResult.buildDirectory = buildDirectory;

          return `Build Complete (${buildPlugin.name})`;
        },
      },
    ]);
    if (taskRef.buildResult.stdout) {
      p.log.success(taskRef.buildResult.stdout);
    }
  } catch (e) {
    // await databasePlugin.onUnmount?.();
    if (e instanceof ExecaError) {
      console.error(e);
    } else if (e instanceof Error) {
      p.log.error(e.stack ?? e.message);
    } else {
      console.error(e);
    }
  }
};
