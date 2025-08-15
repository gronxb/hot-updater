import fs from "fs";
import path from "path";
import * as p from "@clack/prompts";
import { getCwd } from "@hot-updater/plugin-core";
import { createXcodeBuilder } from "./builder/XcodeBuilder";
import {
  type BuildFlags,
  enrichIosNativeBuildSchemeOptions,
} from "./builder/buildOptions";
import type { EnrichedNativeBuildIosScheme } from "./types";
import { assertXcodebuildExist } from "./utils/assertXcodebuildExist";

/**
 * Creates an iOS native build with archive and export capabilities
 */
export const createIosNativeBuild = async ({
  schemeConfig,
  outputPath,
}: {
  schemeConfig: EnrichedNativeBuildIosScheme;
  outputPath: string;
}): Promise<{ buildDirectory: string; buildArtifactPath: string }> => {
  await assertXcodebuildExist();
  const iosProjectRoot = path.join(getCwd(), "ios");

  const buildFlags: BuildFlags = enrichIosNativeBuildSchemeOptions({
    scheme: schemeConfig.scheme,
    configuration: schemeConfig.buildConfiguration,
    archive: true,
    installPods: true,
    exportOptionsPlist: schemeConfig.exportOptionsPlist,
  });

  const builder = createXcodeBuilder(iosProjectRoot, "ios");

  const { archivePath } = await builder.archive({
    scheme: buildFlags.scheme,
    buildConfiguration: buildFlags.configuration,
    platform: "ios",
    extraParams: buildFlags.extraParams,
    installPods: buildFlags.installPods,
    outputPath,
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
};

// TODO: Add advanced build features
// - Build cache management to avoid unnecessary rebuilds
// - Parallel build support for multiple schemes/configurations
// - Build artifact signing verification
// - Build size analysis and optimization suggestions
// - Integration with React Native codegen for new architecture support
