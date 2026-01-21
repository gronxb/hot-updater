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

  // If .app file exists, show its specific location
  if (platform === "ios") {
    const appFiles = await findAppFiles(outputPath);
    if (appFiles.length > 0) {
      p.log.info(`\n📱 .app files:`);
      for (const appFile of appFiles) {
        const relativeAppPath = path.relative(getCwd(), appFile);
        p.log.info(`   ${colors.cyan(relativeAppPath)}`);
      }
    }
  }
};

async function findAppFiles(dir: string): Promise<string[]> {
  const appFiles: string[] = [];
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.endsWith(".app")) {
        appFiles.push(fullPath);
      } else {
        // Recursively search subdirectories
        const subAppFiles = await findAppFiles(fullPath);
        appFiles.push(...subAppFiles);
      }
    }
  }

  return appFiles;
}
