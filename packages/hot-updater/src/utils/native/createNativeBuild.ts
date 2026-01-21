import { colors, getCwd, p } from "@hot-updater/cli-tools";
import type { Platform } from "@hot-updater/core";
import type { BuildPlugin } from "@hot-updater/plugin-core";
import fs from "fs";
import path from "path";

export const createNativeBuild = async ({
  platform,
  outputPath,
  buildPlugin,
  builder,
}: {
  platform: Platform;
  outputPath: string;
  buildPlugin: BuildPlugin;
  builder: () => Promise<{ buildDirectory: string; buildArtifactPath: string }>;
}): Promise<void> => {
  // run prebuild hook
  await buildPlugin.nativeBuild?.prebuild?.({ platform });

  const { buildDirectory } = await builder();

  // run postbuild hook
  await buildPlugin.nativeBuild?.postbuild?.({ platform });

  // copy artifacts to outputPath
  await fs.promises.mkdir(outputPath, { recursive: true });
  await fs.promises.rm(outputPath, {
    recursive: true,
    force: true,
  });
  await fs.promises.cp(buildDirectory, outputPath, {
    recursive: true,
  });

  const relativePath = path.relative(getCwd(), outputPath);
  p.log.info(`Artifact stored at ${colors.blueBright(relativePath)}`);
};
