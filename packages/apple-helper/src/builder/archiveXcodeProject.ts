import fs from "fs";
import path from "path";

import { p } from "@hot-updater/cli-tools";
import type {
  ApplePlatform,
  IosBuildDestination,
} from "@hot-updater/plugin-core";

import { installPodsIfNeeded } from "../utils/cocoapods";
import { createRandomTmpDir } from "../utils/createRandomTmpDir";
import {
  getDefaultDestination,
  resolveDestinations,
} from "../utils/destination";
import {
  parseXcodeProjectInfo,
  type XcodeProjectInfo,
} from "../utils/parseXcodeProjectInfo";
import { prettifyXcodebuildError } from "../utils/prettifyXcodebuildError";
import { runXcodebuildWithLogging } from "../utils/runXcodebuildWithLogging";

export const archiveXcodeProject = async ({
  sourceDir,
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
  xcconfig?: string;
  logPrefix: string;
  /** The MIN_BUNDLE_ID the build compiles in. */
  minBundleId: string;
}): Promise<{ archivePath: string }> => {
  const xcodeProject = await parseXcodeProjectInfo(sourceDir);

  if (installPods) {
    await installPodsIfNeeded(sourceDir);
  }

  const tmpDir = await createRandomTmpDir();

  const archiveName = `${xcodeProject.name.replace(".xcworkspace", "").replace(".xcodeproj", "")}.xcarchive`;
  const archivePath = path.join(tmpDir, archiveName);

  // Settings an xcconfig sets outrank the ones the command line sets, so
  // automatic signing goes in an xcconfig that includes the scheme's.
  const signingXcconfig =
    authenticationArgs && xcconfig
      ? path.join(tmpDir, "HotUpdaterSigning.xcconfig")
      : undefined;
  if (signingXcconfig && xcconfig) {
    await fs.promises.writeFile(
      signingXcconfig,
      `#include "${path.resolve(sourceDir, xcconfig)}"\nCODE_SIGN_STYLE = Automatic\n`,
    );
  }

  const archiveArgs = prepareArchiveArgs({
    authenticationArgs,
    minBundleId,
    archivePath,
    platform,
    sourceDir,
    xcodeProject,
    configuration,
    extraParams,
    destination,
    xcconfig: signingXcconfig ?? xcconfig,
    xcodeScheme,
  });

  p.log.info(`Xcode Archive Settings:
Project    ${xcodeProject.name}
Scheme     ${xcodeScheme}
Platform   ${platform}
Command    xcodebuild ${archiveArgs.join(" ")}
`);

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
    // The key authenticates automatic signing, which a target set to
    // manual signing would not use.
    args.push(...authenticationArgs, "CODE_SIGN_STYLE=Automatic");
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
