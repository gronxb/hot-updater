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
import { createRandomTmpDir, removeTmpDir } from "./utils/createRandomTmpDir";
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
 *
 * The artifact is in a temporary `buildDirectory`, which `dispose` removes
 * once the caller has copied it out. A failed build removes it, and every
 * other directory the build used, itself.
 */
export const buildIos = async ({
  schemeConfig,
  minBundleId = createMinBundleId(),
  credentials,
  logHeader = [],
}: {
  schemeConfig: EnrichedNativeBuildIosScheme;
  /** The MIN_BUNDLE_ID the build compiles in. */
  minBundleId?: string;
  /** Resolves the scheme's `signing` key, when a device build signs with one. */
  credentials?: Pick<CredentialResolver, "resolve">;
  /** Lines the build log starts with, such as the native build key. */
  logHeader?: string[];
}): Promise<{
  buildDirectory: string;
  buildArtifactPath: string;
  /** The build log, which an archive's export appends to, or null. */
  logFilePath: string | null;
  /** What the built app reports, from its Info.plist. */
  builtApp?: {
    appVersion: string | null;
    channel: string | null;
    /** The app's `CFBundleVersion`. */
    buildNumber: string | null;
  };
  /** Removes `buildDirectory`, once the artifact is copied out of it. */
  dispose: () => Promise<void>;
}> => {
  await assertXcodebuildExist();
  if (schemeConfig.simulator && schemeConfig.destination.length) {
    p.log.error(
      "The scheme option 'simulator' is not compatible with the 'destination' option.",
    );
    process.exit(1);
  }

  const buildDirectory = await createRandomTmpDir();
  try {
    const built = await buildInto({
      schemeConfig,
      minBundleId,
      credentials,
      buildDirectory,
      logHeader,
    });
    return { ...built, dispose: () => removeTmpDir(buildDirectory) };
  } catch (error) {
    await removeTmpDir(buildDirectory);
    throw error;
  }
};

const buildInto = async ({
  schemeConfig,
  minBundleId,
  credentials,
  buildDirectory,
  logHeader,
}: {
  schemeConfig: EnrichedNativeBuildIosScheme;
  minBundleId: string;
  credentials?: Pick<CredentialResolver, "resolve">;
  buildDirectory: string;
  logHeader: string[];
}) => {
  const iosProjectRoot = path.join(getCwd(), "ios");

  if (schemeConfig.simulator) {
    const appDir = path.join(buildDirectory, "app");
    await fs.promises.mkdir(appDir, { recursive: true });

    const { appPath, logFilePath } = await buildXcodeProject({
      sourceDir: iosProjectRoot,
      outputDirectory: appDir,
      logPrefix: `ios-${schemeConfig.hotUpdaterSchemeName}-build`,
      header: logHeader,
      platform: schemeConfig.platform,
      xcodeScheme: schemeConfig.scheme,
      configuration: schemeConfig.configuration,
      deviceType: "simulator",
      installPods: schemeConfig.installPods,
      extraParams: schemeConfig.extraParams,
      useGenericDestination: true,
      minBundleId,
    });

    return {
      buildDirectory: buildDirectory,
      buildArtifactPath: appPath,
      logFilePath,
      builtApp: await readBuiltApp(appPath),
    };
  } else {
    const signing = await resolveXcodeSigning({ schemeConfig, credentials });
    if (!signing) {
      return archiveAndExport({
        schemeConfig,
        minBundleId,
        buildDirectory,
        logHeader,
      });
    }
    // In CI, an App Store Connect export signs in a keychain of its own,
    // whose certificates are revoked and deleted with it: its .ipa is signed
    // with the cloud-managed distribution certificate. Another export, such
    // as a development one, may be signed with the certificate Xcode
    // creates, so it keeps the runner's keychains and its certificates.
    const appStoreConnect = await exportsForAppStoreConnect(schemeConfig);
    if (isCI() && !appStoreConnect) {
      p.log.info(
        "Signing in the runner's own keychains (not an App Store Connect export).",
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
          logHeader,
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
  logHeader,
  authenticationArgs,
}: {
  schemeConfig: EnrichedNativeBuildIosScheme;
  minBundleId: string;
  buildDirectory: string;
  logHeader: string[];
  /** Signing arguments from `resolveXcodeSigning`. */
  authenticationArgs?: string[];
}) => {
  const iosProjectRoot = path.join(getCwd(), "ios");
  const archiveDir = path.join(buildDirectory, "archive");
  const exportDir = path.join(buildDirectory, "export");
  await fs.promises.mkdir(archiveDir, { recursive: true });
  // archivePath is the .xcarchive file path
  const { archivePath, logFilePath } = await archiveXcodeProject({
    archiveDirectory: archiveDir,
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
    logPrefix: `ios-${schemeConfig.hotUpdaterSchemeName}-build`,
    header: logHeader,
  });

  // Extract .app from xcarchive if present
  const appFromArchive = extractAppFromXcarchive(archivePath);

  const archivedAppPath = appFromArchive
    ? path.join(archiveDir, path.basename(appFromArchive))
    : undefined;
  if (appFromArchive && archivedAppPath) {
    await fs.promises.cp(appFromArchive, archivedAppPath, {
      recursive: true,
    });
  }

  // Without export options, a scheme that signs with an App Store Connect
  // API key exports for App Store Connect, and any other returns the
  // archive.
  if (!schemeConfig.exportOptionsPlist && !authenticationArgs) {
    return {
      buildDirectory,
      buildArtifactPath: archivePath,
      logFilePath,
      builtApp: archivedAppPath
        ? await readBuiltApp(archivedAppPath)
        : undefined,
    };
  }

  await fs.promises.mkdir(exportDir, { recursive: true });
  const exportArchive = (exportOptionsPlist: string) =>
    exportXcodeArchive({
      archivePath,
      exportPath: exportDir,
      authenticationArgs,
      exportExtraParams: schemeConfig.exportExtraParams,
      exportOptionsPlist,
      sourceDir: iosProjectRoot,
      logPrefix: `ios-${schemeConfig.hotUpdaterSchemeName}-build`,
      // The export's output follows the archive's in one log.
      logFilePath: logFilePath ?? undefined,
      title: schemeConfig.scheme,
    });
  if (schemeConfig.exportOptionsPlist) {
    await exportArchive(schemeConfig.exportOptionsPlist);
  } else {
    const exportOptionsDir = await createRandomTmpDir();
    try {
      await exportArchive(
        await writeAppStoreConnectExportOptions(exportOptionsDir),
      );
    } finally {
      await removeTmpDir(exportOptionsDir);
    }
  }

  const ipaFile = fs
    .readdirSync(exportDir)
    .find((file) => file.endsWith(".ipa"));

  if (!ipaFile) {
    throw new Error("IPA file not found after export");
  }
  return {
    buildDirectory: buildDirectory,
    buildArtifactPath: path.join(exportDir, ipaFile),
    logFilePath,
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
