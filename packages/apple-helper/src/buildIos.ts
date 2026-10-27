import fs from "fs";
import path from "path";

import {
  type CredentialResolver,
  createMinBundleId,
  getCwd,
  isCI,
  p,
} from "@hot-updater/cli-tools";

import { archiveXcodeProject } from "./builder/archiveXcodeProject";
import { buildXcodeProject } from "./builder/buildXcodeProject";
import { exportXcodeArchive } from "./builder/exportXcodeArchive";
import { assertXcodebuildExist } from "./utils/assertXcodebuildExist";
import { withSigningKeychain } from "./utils/ciSigningKeychain";
import { createRandomTmpDir } from "./utils/createRandomTmpDir";
import type { EnrichedNativeBuildIosScheme } from "./utils/enrichNativeBuildIosScheme";
import { readBuiltApp } from "./utils/readBuiltApp";
import {
  exportsForAppStoreConnect,
  resolveXcodeSigning,
  writeAppStoreConnectExportOptions,
} from "./utils/xcodeSigning";

/**
 * Builds a simulator `.app` for a `simulator` scheme, and otherwise archives
 * and exports an `.ipa`, or returns the `.xcarchive` of a scheme it cannot
 * export: one with neither `exportOptionsPlist` nor `signing.ascApiKey`.
 */
export const buildIos = async ({
  schemeConfig,
  minBundleId = createMinBundleId("ios"),
  credentials,
}: {
  schemeConfig: EnrichedNativeBuildIosScheme;
  /** The MIN_BUNDLE_ID the build compiles in. */
  minBundleId?: string;
  /** Resolves the scheme's `signing` key, when a device build signs with one. */
  credentials?: Pick<CredentialResolver, "resolve">;
}): Promise<{
  buildDirectory: string;
  buildArtifactPath: string;
  /** What the built app reports, from its Info.plist. */
  builtApp?: {
    appVersion: string | null;
    channel: string | null;
    /** The app's `CFBundleVersion`. */
    buildNumber: string | null;
  };
}> => {
  await assertXcodebuildExist();
  const iosProjectRoot = path.join(getCwd(), "ios");

  const buildDirectory = await createRandomTmpDir();
  await fs.promises.mkdir(path.join(buildDirectory, "archive"), {
    recursive: true,
  });

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
    const signing = await resolveXcodeSigning({ schemeConfig, credentials });
    if (!signing) {
      return archiveAndExport({ schemeConfig, minBundleId, buildDirectory });
    }
    // In CI, an App Store Connect export signs in a keychain of its own,
    // whose certificates are revoked and deleted with it: its .ipa is signed
    // with the cloud-managed distribution certificate. Another export, such
    // as a development one, may be signed with the certificate Xcode
    // creates, so it keeps the runner's keychains and its certificates.
    const appStoreConnect = await exportsForAppStoreConnect(schemeConfig);
    if (isCI() && !appStoreConnect) {
      p.log.info(
        "This export isn't for App Store Connect, so it signs in the runner's own keychains and keeps the certificates Xcode creates.",
      );
    }
    return withSigningKeychain({
      enabled: isCI() && appStoreConnect,
      apiKey: signing.apiKey,
      run: () =>
        archiveAndExport({
          schemeConfig,
          minBundleId,
          buildDirectory,
          authenticationArgs: signing.authenticationArgs,
        }),
    });
  }
};

/**
 * Archives a device build and exports its `.ipa`, or returns the
 * `.xcarchive` of a scheme it cannot export.
 */
const archiveAndExport = async ({
  schemeConfig,
  minBundleId,
  buildDirectory,
  authenticationArgs,
}: {
  schemeConfig: EnrichedNativeBuildIosScheme;
  minBundleId: string;
  buildDirectory: string;
  /** Signing arguments from `resolveXcodeSigning`. */
  authenticationArgs?: string[];
}) => {
  const iosProjectRoot = path.join(getCwd(), "ios");
  const archiveDir = path.join(buildDirectory, "archive");
  const exportDir = path.join(buildDirectory, "export");
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

  // Without export options, a scheme that signs with an App Store Connect
  // API key exports for App Store Connect, and any other returns the
  // archive.
  if (!schemeConfig.exportOptionsPlist && !authenticationArgs) {
    return {
      buildDirectory,
      buildArtifactPath: finalArchivePath,
      builtApp: archivedAppPath
        ? await readBuiltApp(archivedAppPath)
        : undefined,
    };
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
    builtApp: archivedAppPath ? await readBuiltApp(archivedAppPath) : undefined,
  };
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
