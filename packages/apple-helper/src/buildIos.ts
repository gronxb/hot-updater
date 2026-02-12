import { getCwd, p } from "@hot-updater/cli-tools";
import type { NativeBuildIosScheme } from "@hot-updater/plugin-core";
import fs from "fs";
import path from "path";
import { archiveXcodeProject } from "./builder/archiveXcodeProject";
import { buildXcodeProject } from "./builder/buildXcodeProject";
import { exportXcodeArchive } from "./builder/exportXcodeArchive";
import { assertXcodebuildExist } from "./utils/assertXcodebuildExist";
import { createRandomTmpDir } from "./utils/createRandomTmpDir";
import { enrichNativeBuildIosScheme } from "./utils/enrichNativeBuildIosScheme";

export const buildIos = async ({
  schemeConfig: _schemeConfig,
}: {
  schemeConfig: NativeBuildIosScheme;
}): Promise<{ buildDirectory: string; buildArtifactPath: string }> => {
  await assertXcodebuildExist();
  const iosProjectRoot = path.join(getCwd(), "ios");

  const schemeConfig = await enrichNativeBuildIosScheme(_schemeConfig);

  const buildDirectory = await createRandomTmpDir();
  const archiveDir = path.join(buildDirectory, "archive");
  const exportDir = path.join(buildDirectory, "export");
  await fs.promises.mkdir(archiveDir, { recursive: true });

  if (schemeConfig.simulator) {
    if (schemeConfig.destination.length) {
      p.log.error(
        "The scheme option 'simulator' is not compatible with the 'destination' option.",
      );
      process.exit(1);
    }
    const appDir = path.join(buildDirectory, "app");
    await fs.promises.mkdir(appDir, { recursive: true });

    const { appPath } = await buildXcodeProject({
      sourceDir: iosProjectRoot,
      platform: schemeConfig.platform,
      scheme: schemeConfig.scheme,
      configuration: schemeConfig.configuration,
      deviceType: "simulator",
      installPods: schemeConfig.installPods,
      extraParams: schemeConfig.extraParams,
      useGenericDestination: true,
    });

    const finalAppPath = path.join(appDir, path.basename(appPath));
    await fs.promises.cp(appPath, finalAppPath, { recursive: true });

    p.log.success(`.app file created: ${path.basename(appPath)}`);

    return {
      buildDirectory: buildDirectory,
      buildArtifactPath: finalAppPath,
    };
  } else {
    // archivePath is the .xcarchive file path
    const { archivePath } = await archiveXcodeProject({
      platform: schemeConfig.platform,
      sourceDir: iosProjectRoot,
      xcconfig: schemeConfig.xcconfig,
      scheme: schemeConfig.scheme,
      destination: schemeConfig.destination,
      extraParams: schemeConfig.extraParams,
      configuration: schemeConfig.configuration,
      installPods: schemeConfig.installPods,
    });

    const finalArchivePath = path.join(archiveDir, path.basename(archivePath));
    await fs.promises.cp(archivePath, finalArchivePath, { recursive: true });

    // Extract .app from xcarchive if present
    const appFromArchive = extractAppFromXcarchive(finalArchivePath);

    if (appFromArchive) {
      await fs.promises.cp(
        appFromArchive,
        path.join(archiveDir, path.basename(appFromArchive)),
        { recursive: true },
      );
      p.log.success(".app extracted from .xcarchive");
    }

    // if export is needed
    if (schemeConfig.exportOptionsPlist) {
      await fs.promises.mkdir(exportDir, { recursive: true });

      const { exportPath } = await exportXcodeArchive({
        archivePath,
        exportExtraParams: schemeConfig.exportExtraParams,
        exportOptionsPlist: schemeConfig.exportOptionsPlist!,
        sourceDir: iosProjectRoot,
      });

      await fs.promises.cp(exportPath, exportDir, { recursive: true });

      const ipaFile = fs
        .readdirSync(exportDir)
        .find((file) => file.endsWith(".ipa"));

      if (ipaFile) {
        const ipaPath = path.join(exportDir, ipaFile);
        return {
          buildDirectory: buildDirectory,
          buildArtifactPath: ipaPath,
        };
      }
      throw new Error("IPA file not found after export");
    }
    return {
      buildDirectory,
      buildArtifactPath: finalArchivePath,
    };
  }
};

const extractAppFromXcarchive = (archivePath: string) => {
  const productsPath = path.join(archivePath, "Products", "Applications");

  if (!fs.existsSync(productsPath)) {
    return;
  }

  const files = fs.readdirSync(productsPath);
  const appFile = files.find((file) => file.endsWith(".app"));
  if (appFile) {
    return path.join(productsPath, appFile);
  }

  p.log.warn("Failed to extract .app from xcarchive");
};

// TODO: Add advanced build features
// - Build cache management to avoid unnecessary rebuilds
// - Parallel build support for multiple schemes/configurations
// - Build artifact signing verification
// - Build size analysis and optimization suggestions
// - Integration with React Native codegen for new architecture support
