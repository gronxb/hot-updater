import * as p from "@clack/prompts";
import type {
  ApplePlatform,
  NativeBuildIosScheme,
} from "@hot-updater/plugin-core";
import { execa } from "execa";
import path from "path";
import { installPodsIfNeeded } from "../utils/cocoapods";
import { createRandomTmpDir } from "../utils/createRandomTmpDir";
import {
  getDefaultDestination,
  resolveDestinations,
} from "../utils/destination";
import {
  discoverXcodeProject,
  type XcodeProjectInfo,
} from "../utils/projectInfo";
import { createXcodebuildLogger } from "./createXcodebuildLogger";

export const archiveXcodeProject = async ({
  sourceDir,
  platform,
  schemeConfig,
}: {
  sourceDir: string;
  schemeConfig: NativeBuildIosScheme;
  platform: ApplePlatform;
}): Promise<{ archivePath: string }> => {
  const xcodeProject = await discoverXcodeProject(sourceDir);

  if (schemeConfig.installPods ?? true) {
    await installPodsIfNeeded(sourceDir);
  }

  const tmpDir = await createRandomTmpDir();

  const archiveName = `${xcodeProject.name.replace(".xcworkspace", "").replace(".xcodeproj", "")}.xcarchive`;
  const archivePath = path.join(tmpDir, archiveName);

  const archiveArgs = prepareArchiveArgs({
    archivePath,
    platform,
    schemeConfig,
    sourceDir,
    xcodeProject,
  });

  p.log.info(`Xcode Archive Settings:
Project    ${xcodeProject.name}
Scheme     ${schemeConfig.scheme}
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
    throw new Error(`Xcode archive failed: ${error}`);
  }
};

const prepareArchiveArgs = ({
  archivePath,
  platform,
  schemeConfig,
  sourceDir,
  xcodeProject,
}: {
  archivePath: string;
  platform: ApplePlatform;
  schemeConfig: NativeBuildIosScheme;
  sourceDir: string;
  xcodeProject: XcodeProjectInfo;
}): string[] => {
  const args = [
    xcodeProject.isWorkspace ? "-workspace" : "-project",
    path.join(sourceDir, xcodeProject.name),
    "-scheme",
    schemeConfig.scheme,
    "-configuration",
    schemeConfig.configuration || "Release",
    "archive",
    "-archivePath",
    archivePath,
  ];

  if (schemeConfig.xcconfig) {
    args.push("-xcconfig", schemeConfig.xcconfig);
  }

  if (schemeConfig.extraParams) {
    args.push(...schemeConfig.extraParams);
  }

  const resolvedDestinations = resolveDestinations({
    destinations: schemeConfig.destination || [],
    useGeneric: true,
  });
  if (resolvedDestinations.length === 0) {
    resolvedDestinations.push(
      getDefaultDestination({
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
