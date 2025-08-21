import { createNativeBuild } from "@/utils/native/createNativeBuild";
import { installAndLaunch } from "@/utils/native/installAndLaunch";
import { prepareNativeBuild } from "@/utils/native/prepareNativeBuild";
import { printBanner } from "@/utils/printBanner";
import * as p from "@clack/prompts";
import {
  type AndroidDeviceData,
  createAndroidNativeBuild,
  enrichAndroidNativeBuildSchemeOptions,
  selectAndroidTargetDevice,
} from "@hot-updater/android-helper";
import { createIosNativeBuild } from "@hot-updater/apple-helper";
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

  const { outputPath, platform, config, scheme } = preparedConfig;
  const cwd = getCwd();

  const buildPlugin = await config.build({ cwd });

  try {
    const taskRef: {
      buildResult: {
        stdout: string | null;
        buildDirectory: string | null;
        buildArtifactPath: string | null;
      };
    } = {
      buildResult: {
        buildArtifactPath: null,
        stdout: null,
        buildDirectory: null,
      },
    };

    let androidDevice: AndroidDeviceData | undefined;
    // TODO: select ios device
    const iosDevice: any | undefined = undefined;

    if (platform === "android") {
      androidDevice = (
        await selectAndroidTargetDevice({
          interactive: options.interactive,
          deviceOption: options.device,
        })
      ).device;
    }
    if (platform === "ios") {
    }

    await p.tasks([
      {
        title: `📦 Building Native (${buildPlugin.name})`,
        task: async () => {
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

          const { buildDirectory, buildArtifactPath } = await createNativeBuild(
            {
              buildPlugin,
              platform,
              outputPath,
              builder,
            },
          );
          await installAndLaunch({ buildArtifactPath });
          taskRef.buildResult.buildArtifactPath = buildArtifactPath;
          taskRef.buildResult.buildDirectory = buildDirectory;

          return `Build Complete (${buildPlugin.name})`;
        },
      },
      {
        title: "Install Artifact",
        task: async () => {
          return "Install Complete";
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
  // await installAndLaunchApp(platform, outputPath, config);
};
