import fs from "node:fs";
import path from "node:path";
import * as p from "@clack/prompts";
import type { NativeBuildIosScheme } from "@hot-updater/plugin-core";
import { getCwd } from "@hot-updater/plugin-core";
import { validateBuildOptions } from "./builder/buildOptions";
import type { BuildFlags } from "./builder/buildOptions";
import { createXcodeBuilder } from "./builder/xcodeBuilder";

/**
 * Creates an iOS native build with archive and export capabilities
 */
export const createIosNativeBuild = async ({
  schemeConfig,
}: {
  schemeConfig: NativeBuildIosScheme;
}): Promise<{ buildDirectory: string; buildArtifactPath: string }> => {
  const iosProjectRoot = path.join(getCwd(), "ios");

  const buildFlags: BuildFlags = validateBuildOptions({
    scheme: schemeConfig.scheme,
    configuration: schemeConfig.buildConfiguration,
    archive: true, // Always create archive for distribution
    installPods: true,
    exportOptionsPlist: schemeConfig.exportOptionsPlist,
  });

  p.log.info(JSON.stringify(buildFlags, null, 2));

  const builder = createXcodeBuilder(iosProjectRoot, "ios");

  try {
    p.log.info("Creating iOS archive...");
    const { archivePath } = await builder.archive({
      scheme: buildFlags.scheme,
      buildConfiguration: buildFlags.configuration,
      platform: "ios",
      extraParams: buildFlags.extraParams,
      buildFolder: buildFlags.buildFolder,
    });

    if (buildFlags.exportOptionsPlist) {
      p.log.info("Exporting archive to IPA...");
      const { exportPath } = await builder.exportArchive({
        archivePath,
        exportOptionsPlist: buildFlags.exportOptionsPlist,
        exportExtraParams: buildFlags.exportExtraParams,
      });

      // Find the IPA file in export directory
      const files = fs.readdirSync(exportPath);
      const ipaFile = files.find((file) => file.endsWith(".ipa"));

      if (ipaFile) {
        const ipaPath = path.join(exportPath, ipaFile);
        return {
          buildDirectory: exportPath,
          buildArtifactPath: ipaPath,
        };
      }
    }

    // If no export options or IPA not found, return archive path
    return {
      buildDirectory: path.dirname(archivePath),
      buildArtifactPath: archivePath,
    };
  } catch (error) {
    p.log.error(`iOS build failed: ${error}`);
    throw error;
  }
};

// TODO: Add advanced build features
// - Build cache management to avoid unnecessary rebuilds
// - Parallel build support for multiple schemes/configurations
// - Build artifact signing verification
// - Build size analysis and optimization suggestions
// - Integration with React Native codegen for new architecture support
