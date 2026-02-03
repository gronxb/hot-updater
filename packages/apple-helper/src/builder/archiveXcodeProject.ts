import { p } from "@hot-updater/cli-tools";

import {
  type ApplePlatform,
  generateMinBundleId,
  type IosBuildDestination,
} from "@hot-updater/plugin-core";
import { execa } from "execa";
import path from "path";

import { installPodsIfNeeded } from "../utils/cocoapods";
import { createRandomTmpDir } from "../utils/createRandomTmpDir";
import { createXcodebuildLogger } from "../utils/createXcodebuildLogger";
import {
  getDefaultDestination,
  resolveDestinations,
} from "../utils/destination";
import {
  parseXcodeProjectInfo,
  type XcodeProjectInfo,
} from "../utils/parseXcodeProjectInfo";
import { prettifyXcodebuildError } from "../utils/prettifyXcodebuildError";

export const archiveXcodeProject = async ({
  sourceDir,
  platform,
  installPods,
  destination,
  extraParams,
  configuration,
  scheme,
  xcconfig,
}: {
  configuration?: string;
  destination?: IosBuildDestination[];
  extraParams?: string[];
  installPods: boolean;
  platform: ApplePlatform;
  scheme: string;
  sourceDir: string;
  xcconfig?: string;
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
    scheme,
  });

  p.log.info(`Xcode Archive Settings:
Project    ${xcodeProject.name}
Scheme     ${scheme}
Platform   ${platform}
Command    xcodebuild ${archiveArgs.join(" ")}
`);

  const logger = createXcodebuildLogger();
  logger.start(`${xcodeProject.name} (Archive)`);

  try {
    const process = execa("xcodebuild", archiveArgs, {
      cwd: sourceDir,
    });

    for await (const line of process) {
      logger.processLine(line);
    }

    logger.stop("Archive completed successfully");

    return { archivePath };
  } catch (error) {
    logger.stop("Archive failed", false);
    throw prettifyXcodebuildError(error);
  }
};

const prepareArchiveArgs = ({
  scheme,
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
  scheme: string;
  xcconfig?: string;
  sourceDir: string;
  xcodeProject: XcodeProjectInfo;
}): string[] => {
  const args = [
    xcodeProject.isWorkspace ? "-workspace" : "-project",
    path.join(sourceDir, xcodeProject.name),
    "-scheme",
    scheme,
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
