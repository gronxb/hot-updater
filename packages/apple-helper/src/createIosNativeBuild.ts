import fs from "fs";
import path from "path";
import * as p from "@clack/prompts";
import { type NativeBuildIosScheme, getCwd } from "@hot-updater/plugin-core";
import { archiveXcodeProject } from "./builder/archiveXcodeProject";
import { exportXcodeArchive } from "./builder/exportXcodeArchive";
import { assertXcodebuildExist } from "./utils/assertXcodebuildExist";

export const createIosNativeBuild = async ({
  schemeConfig,
}: {
  schemeConfig: NativeBuildIosScheme;
}): Promise<{ buildDirectory: string; buildArtifactPath: string }> => {
  await assertXcodebuildExist();
  const iosProjectRoot = path.join(getCwd(), "ios");

  const { archivePath } = await archiveXcodeProject({
    platform: schemeConfig.platform ?? "ios",
    schemeConfig,
    sourceDir: iosProjectRoot,
  });

  if (schemeConfig.exportOptionsPlist) {
    p.log.info("Exporting archive to IPA...");
    const { exportPath } = await exportXcodeArchive({
      archivePath,
      schemeConfig,
      sourceDir: iosProjectRoot,
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
    throw new Error("IPA file not found after export");
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
