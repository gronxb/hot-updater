import fs from "fs";
import path from "path";
import { createNativeBuild } from "@/utils/native/createNativeBuild";
import { prepareNativeBuild } from "@/utils/native/prepareNativeBuild";
import * as p from "@clack/prompts";
import type { Platform } from "@hot-updater/core";
import { getCwd } from "@hot-updater/plugin-core";
import { ExecaError } from "execa";
import picocolors from "picocolors";

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
    return;
  }
  const cwd = getCwd();
  const { config, outputPath, platform, scheme } = preparedConfig;

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
          await buildPlugin.nativeBuild?.prebuild?.({ platform });
          const { buildDirectory, buildArtifactPath } = await createNativeBuild(
            {
              platform,
              config: config.nativeBuild,
              scheme,
            },
          );
          taskRef.buildResult.buildArtifactPath = buildArtifactPath;
          taskRef.buildResult.buildDirectory = buildDirectory;

          await buildPlugin.nativeBuild?.postbuild?.({ platform });

          await fs.promises.mkdir(outputPath, { recursive: true });

          p.log.success(
            `Artifact stored at ${picocolors.blueBright(path.relative(getCwd(), outputPath))}.`,
          );

          await fs.promises.rm(outputPath, {
            recursive: true,
            force: true,
          });
          await fs.promises.cp(
            taskRef.buildResult.buildDirectory!,
            outputPath,
            { recursive: true },
          );

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
