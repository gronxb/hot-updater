import fs from "fs";
import path from "path";

import { type CredentialResolver, getCwd, p } from "@hot-updater/cli-tools";

import { archiveXcodeProject } from "./builder/archiveXcodeProject";
import { buildXcodeProject } from "./builder/buildXcodeProject";
import { exportXcodeArchive } from "./builder/exportXcodeArchive";
import { assertXcodebuildExist } from "./utils/assertXcodebuildExist";
import { createRandomTmpDir } from "./utils/createRandomTmpDir";
import type { EnrichedNativeBuildIosScheme } from "./utils/enrichNativeBuildIosScheme";
import { readBuiltApp } from "./utils/readBuiltApp";
import {
  resolveXcodeAuthenticationArgs,
  writeAppStoreConnectExportOptions,
} from "./utils/xcodeSigning";

/**
 * Builds a simulator `.app` for a `simulator` scheme, and otherwise archives
 * and exports an `.ipa`.
 */
export const buildIos = async ({
  schemeConfig,
  minBundleId,
  credentials,
}: {
  schemeConfig: EnrichedNativeBuildIosScheme;
  /** The MIN_BUNDLE_ID the build compiles in. */
  minBundleId: string;
  credentials: Pick<CredentialResolver, "resolve">;
}): Promise<{
  buildDirectory: string;
  buildArtifactPath: string;
  /** What the built app reports, from its Info.plist. */
  builtApp?: { appVersion: string | null; channel: string | null };
}> => {
  await assertXcodebuildExist();
  const iosProjectRoot = path.join(getCwd(), "ios");

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
      logPrefix: `ios-${schemeConfig.hotUpdaterSchemeName}-build`,
      platform: schemeConfig.platform,
      xcodeScheme: schemeConfig.scheme,
      configuration: schemeConfig.configuration,
      deviceType: "simulator",
      installPods: schemeConfig.installPods,
      extraParams: schemeConfig.extraParams,
      useGenericDestination: true,
      minBundleId,
    });

    const finalAppPath = path.join(appDir, path.basename(appPath));
    await fs.promises.cp(appPath, finalAppPath, { recursive: true });

    p.log.success(`.app file created: ${path.basename(appPath)}`);

    return {
      buildDirectory: buildDirectory,
      buildArtifactPath: finalAppPath,
      builtApp: await readBuiltApp(finalAppPath),
    };
  } else {
    if (!schemeConfig.exportOptionsPlist && !schemeConfig.signing?.ascApiKey) {
      throw new Error(
        `nativeBuild.ios.${schemeConfig.hotUpdaterSchemeName} builds for devices, which exports an .ipa with exportOptionsPlist. Set exportOptionsPlist, or signing.ascApiKey to export for App Store Connect with automatic signing.`,
      );
    }
    const authenticationArgs = await resolveXcodeAuthenticationArgs({
      schemeConfig,
      credentials,
    });

    // archivePath is the .xcarchive file path
    const { archivePath } = await archiveXcodeProject({
      authenticationArgs,
      minBundleId,
      platform: schemeConfig.platform,
      sourceDir: iosProjectRoot,
      xcconfig: schemeConfig.xcconfig,
      xcodeScheme: schemeConfig.scheme,
      destination: schemeConfig.destination,
      extraParams: schemeConfig.extraParams,
      configuration: schemeConfig.configuration,
      installPods: schemeConfig.installPods,
      logPrefix: `ios-${schemeConfig.hotUpdaterSchemeName}-build-archive`,
    });

    const finalArchivePath = path.join(archiveDir, path.basename(archivePath));
    await fs.promises.cp(archivePath, finalArchivePath, { recursive: true });

    // Extract .app from xcarchive if present
    const appFromArchive = extractAppFromXcarchive(finalArchivePath);

    const archivedAppPath = appFromArchive
      ? path.join(archiveDir, path.basename(appFromArchive))
      : undefined;
    if (appFromArchive && archivedAppPath) {
      await fs.promises.cp(appFromArchive, archivedAppPath, {
        recursive: true,
      });
      p.log.success(".app extracted from .xcarchive");
    }

    await fs.promises.mkdir(exportDir, { recursive: true });
    const exportOptionsPlist =
      schemeConfig.exportOptionsPlist ??
      (await writeAppStoreConnectExportOptions(await createRandomTmpDir()));

    const { exportPath } = await exportXcodeArchive({
      archivePath,
      authenticationArgs,
      exportExtraParams: schemeConfig.exportExtraParams,
      exportOptionsPlist,
      sourceDir: iosProjectRoot,
      logPrefix: `ios-${schemeConfig.hotUpdaterSchemeName}-build-export`,
    });

    await fs.promises.cp(exportPath, exportDir, { recursive: true });

    const ipaFile = fs
      .readdirSync(exportDir)
      .find((file) => file.endsWith(".ipa"));

    if (!ipaFile) {
      throw new Error("IPA file not found after export");
    }
    return {
      buildDirectory: buildDirectory,
      buildArtifactPath: path.join(exportDir, ipaFile),
      builtApp: archivedAppPath
        ? await readBuiltApp(archivedAppPath)
        : undefined,
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
