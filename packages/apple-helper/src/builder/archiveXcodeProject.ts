import { p } from "@hot-updater/cli-tools";

import {
  type ApplePlatform,
  generateMinBundleId,
  type IosBuildDestination,
} from "@hot-updater/plugin-core";
import path from "path";

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
}: {
  configuration?: string;
  destination?: IosBuildDestination[];
  extraParams?: string[];
  installPods: boolean;
  platform: ApplePlatform;
  xcodeScheme: string;
  sourceDir: string;
  xcconfig?: string;
  logPrefix: string;
}): Promise<{ archivePath: string }> => {
  const xcodeProject = await parseXcodeProjectInfo(sourceDir);

  if (installPods) {
    await installPodsIfNeeded(sourceDir);
  }

  const tmpDir = await createRandomTmpDir();

  const archiveName = `${xcodeProject.name.replace(".xcworkspace", "").replace(".xcodeproj", "")}.xcarchive`;
  const archivePath = path.join(tmpDir, archiveName);

  const archiveArgs = prepareArchiveArgs({
    archivePath,
    platform,
    sourceDir,
    xcodeProject,
    configuration,
    extraParams,
    destination,
    xcconfig,
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
}: {
  archivePath: string;
  configuration?: string;
  destination?: IosBuildDestination[];
  extraParams?: string[];
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
    `HOT_UPDATER_MIN_BUNDLE_ID=${generateMinBundleId()}`,
  ];

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
