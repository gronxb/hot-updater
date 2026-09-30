import fs from "fs";
import path from "path";

import { colors, getCwd, p } from "@hot-updater/cli-tools";
import type { Platform } from "@hot-updater/core";
import type { BuildAdapter } from "@hot-updater/plugin-core";

export const createNativeBuild = async ({
  platform,
  outputPath,
  buildAdapter,
  builder,
}: {
  platform: Platform;
  outputPath: string;
  buildAdapter: BuildAdapter;
  builder: () => Promise<{ buildDirectory: string; buildArtifactPath: string }>;
}): Promise<void> => {
  // run prebuild hook
  await buildAdapter.nativeBuild?.prebuild?.({ platform });

  const { buildDirectory } = await builder();

  // run postbuild hook
  await buildAdapter.nativeBuild?.postbuild?.({ platform });

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
