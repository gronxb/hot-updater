import path from "path";

import { p } from "@hot-updater/cli-tools";
import type {
  ApplePlatform,
  IosBuildDestination,
} from "@hot-updater/plugin-core";

import { installPodsIfNeeded } from "../utils/cocoapods";
import { createRandomTmpDir, removeTmpDir } from "../utils/createRandomTmpDir";
import {
  getDefaultDestination,
  resolveDestinations,
} from "../utils/destination";
import { formatCommand } from "../utils/formatCommand";
import {
  parseXcodeProjectInfo,
  type XcodeProjectInfo,
} from "../utils/parseXcodeProjectInfo";
import { prettifyXcodebuildError } from "../utils/prettifyXcodebuildError";
import { runXcodebuildWithLogging } from "../utils/runXcodebuildWithLogging";
import {
  buildSettingsOverScheme,
  writeBuildXcconfig,
} from "../utils/writeBuildXcconfig";

/**
 * Archives the scheme into `archiveDirectory`. The build's xcconfig is
 * written to a temporary directory, removed whether the archive succeeds or
 * not.
 */
export const archiveXcodeProject = async ({
  sourceDir,
  archiveDirectory,
  platform,
  installPods,
  destination,
  extraParams,
  configuration,
  xcodeScheme,
  xcconfig,
  logPrefix,
  minBundleId,
  authenticationArgs,
}: {
  /** Signing arguments from `resolveXcodeAuthenticationArgs`. */
  authenticationArgs?: string[];
  configuration?: string;
  destination?: IosBuildDestination[];
  extraParams?: string[];
  installPods: boolean;
  platform: ApplePlatform;
  xcodeScheme: string;
  sourceDir: string;
  /** Where the `.xcarchive` is written. */
  archiveDirectory: string;
  xcconfig?: string;
  logPrefix: string;
  /** The MIN_BUNDLE_ID the build compiles in. */
  minBundleId: string;
}): Promise<{ archivePath: string }> => {
  if (installPods) {
    await installPodsIfNeeded(sourceDir);
  }

  // After pod install, which writes the workspace of a freshly prebuilt
  // project.
  const xcodeProject = await parseXcodeProjectInfo(sourceDir);

  const archiveName = `${xcodeProject.name.replace(".xcworkspace", "").replace(".xcodeproj", "")}.xcarchive`;
  const archivePath = path.join(archiveDirectory, archiveName);

  const tmpDir = await createRandomTmpDir();
  try {
    const build = await writeBuildXcconfig({
      directory: tmpDir,
      sourceDir,
      xcconfig,
      extraParams,
      settings: buildSettingsOverScheme({ minBundleId, authenticationArgs }),
    });

    const archiveArgs = prepareArchiveArgs({
      authenticationArgs,
      minBundleId,
      archivePath,
      platform,
      sourceDir,
      xcodeProject,
      configuration,
      extraParams: build.extraParams,
      destination,
      xcconfig: build.xcconfig,
      xcodeScheme,
    });

    p.log.info(
      [
        "Xcode archive",
        `Project   ${xcodeProject.name}`,
        `Scheme    ${xcodeScheme}`,
        `Platform  ${platform}`,
        "Command",
        formatCommand(["xcodebuild", ...archiveArgs]),
      ].join("\n"),
    );

    try {
      await runXcodebuildWithLogging({
        args: archiveArgs,
        // The build setting reaches the podspec's script phase, and the
        // environment reaches Package.swift's build tool plugin, which
        // can't read build settings.
        env: { HOT_UPDATER_MIN_BUNDLE_ID: minBundleId },
        failureMessage: "Archive failed",
        logPrefix,
        sourceDir,
        successMessage: "Archive completed successfully",
      });

      return { archivePath };
    } catch (error) {
      throw prettifyXcodebuildError(error);
    }
  } finally {
    await removeTmpDir(tmpDir);
  }
};

const prepareArchiveArgs = ({
  xcodeScheme,
  archivePath,
  platform,
  sourceDir,
  xcodeProject,
  configuration = "Release",
  xcconfig,
  extraParams,
  destination = [],
  minBundleId,
  authenticationArgs,
}: {
  archivePath: string;
  authenticationArgs?: string[];
  configuration?: string;
  destination?: IosBuildDestination[];
  extraParams?: string[];
  minBundleId: string;
  platform: ApplePlatform;
  xcodeScheme: string;
  xcconfig?: string;
  sourceDir: string;
  xcodeProject: XcodeProjectInfo;
}): string[] => {
  const args = [
    xcodeProject.isWorkspace ? "-workspace" : "-project",
    path.join(sourceDir, xcodeProject.name),
    "-scheme",
    xcodeScheme,
    "-configuration",
    configuration,
    "archive",
    "-archivePath",
    archivePath,
    `HOT_UPDATER_MIN_BUNDLE_ID=${minBundleId}`,
  ];

  if (authenticationArgs) {
    args.push(...authenticationArgs);
  }

  if (xcconfig) {
    args.push("-xcconfig", xcconfig);
  }

  if (extraParams) {
    args.push(...extraParams);
  }

  const resolvedDestinations = resolveDestinations({
    destinations: destination,
    useGeneric: true,
  });
  if (resolvedDestinations.length === 0) {
    resolvedDestinations.push(
      getDefaultDestination({
        deviceType: "device",
        platform,
        useGeneric: true,
      }),
    );
  }

  for (const destination of resolvedDestinations) {
    args.push("-destination", destination);
  }

  return args;
};
