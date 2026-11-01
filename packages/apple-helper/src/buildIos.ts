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
import type { SandboxArchivePlan } from "./sandboxTestFlight";
import { assertXcodebuildExist } from "./utils/assertXcodebuildExist";
import { withSigningKeychain } from "./utils/ciSigningKeychain";
import { createRandomTmpDir, removeTmpDir } from "./utils/createRandomTmpDir";
import type { EnrichedNativeBuildIosScheme } from "./utils/enrichNativeBuildIosScheme";
import { readBuiltApp } from "./utils/readBuiltApp";
import {
  patchSandboxArchive,
  patchSandboxSimulatorApp,
} from "./utils/sandboxInfoPlist";
import {
  exportsForAppStoreConnect,
  exportsForRegisteredDevices,
  resolveSandboxExportOptions,
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
  sandbox,
  logHeader = [],
}: {
  schemeConfig: EnrichedNativeBuildIosScheme;
  /** The MIN_BUNDLE_ID the build compiles in. */
  minBundleId?: string;
  /** Resolves the scheme's `signing` key, when a device build signs with one. */
  credentials?: Pick<CredentialResolver, "resolve">;
  /**
   * What a `sandbox` scheme's archive takes from App Store Connect: its
   * closed version train and next build number, and what a closed train does.
   */
  sandbox?: SandboxArchivePlan;
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
      sandbox,
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
  sandbox,
  buildDirectory,
  logHeader,
}: {
  schemeConfig: EnrichedNativeBuildIosScheme;
  minBundleId: string;
  credentials?: Pick<CredentialResolver, "resolve">;
  sandbox?: SandboxArchivePlan;
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
      sandbox: schemeConfig.sandbox,
    });
    if (schemeConfig.sandbox) {
      await patchSandboxSimulatorApp(appPath, schemeConfig);
    }

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
        sandbox,
        buildDirectory,
        logHeader,
      });
    }
    // In CI, an App Store Connect or ad hoc export signs in a keychain of its
    // own, whose certificates are revoked and deleted with it: its .ipa is
    // signed with the cloud-managed distribution certificate. Another export,
    // such as a development one, may be signed with the certificate Xcode
    // creates, so it keeps the runner's keychains and its certificates.
    const registeredDevices = await exportsForRegisteredDevices(schemeConfig);
    const ownKeychain =
      registeredDevices || (await exportsForAppStoreConnect(schemeConfig));
    if (isCI() && !ownKeychain) {
      p.log.info(
        "Signing in the runner's own keychains (not an App Store Connect or ad hoc export).",
      );
    }
    return withSigningKeychain({
      enabled: isCI() && ownKeychain,
      keepDistribution: registeredDevices,
      apiKey: signing.apiKey,
      run: () =>
        archiveAndExport({
          schemeConfig,
          minBundleId,
          sandbox,
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
  sandbox,
  buildDirectory,
  logHeader,
  authenticationArgs,
}: {
  schemeConfig: EnrichedNativeBuildIosScheme;
  minBundleId: string;
  sandbox?: SandboxArchivePlan;
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
    sandbox: schemeConfig.sandbox,
  });

  // Extract .app from xcarchive if present
  const appFromArchive = extractAppFromXcarchive(archivePath);

  // Before the copy, which reports what the app does, and before the export,
  // which signs the patched app.
  if (schemeConfig.sandbox) {
    if (!appFromArchive) {
      throw new Error(`The archive ${archivePath} has no app to patch.`);
    }
    await patchSandboxArchive({
      archivePath,
      appPath: appFromArchive,
      schemeConfig,
      plan: sandbox,
    });
  }

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
  const { exportOptionsPlist } = schemeConfig;
  if (exportOptionsPlist && !schemeConfig.sandbox) {
    await exportArchive(exportOptionsPlist);
  } else {
    const exportOptionsDir = await createRandomTmpDir();
    try {
      await exportArchive(
        exportOptionsPlist
          ? await resolveSandboxExportOptions(
              schemeConfig.hotUpdaterSchemeName,
              exportOptionsPlist,
              exportOptionsDir,
            )
          : await writeAppStoreConnectExportOptions(exportOptionsDir, {
              internalTestingOnly: schemeConfig.sandbox,
            }),
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
