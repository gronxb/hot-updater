import * as p from "@clack/prompts";
import type { ApplePlatform } from "@hot-updater/plugin-core";
import { execa } from "execa";
import path from "path";
import type { AppleDeviceType } from "../types";
import { installPodsIfNeeded } from "../utils/cocoapods";
import { createRandomTmpDir } from "../utils/createRandomTmpDir";
import { platformConfigs } from "../utils/platform";
import {
  discoverXcodeProject,
  type XcodeProjectInfo,
} from "../utils/projectInfo";
import { createXcodebuildLogger } from "./createXcodebuildLogger";

export const buildXcodeProject = async ({
  sourceDir,
  platform,
  scheme,
  configuration,
  deviceType,
  udid,
  installPods,
  extraParams,
}: {
  sourceDir: string;
  platform: ApplePlatform;
  scheme: string;
  configuration: string;
  deviceType: AppleDeviceType;
  udid?: string;
  installPods?: boolean;
  extraParams?: string[];
}): Promise<{ appPath: string; infoPlistPath: string }> => {
  const xcodeProject = await discoverXcodeProject(sourceDir);

  if (installPods ?? true) {
    await installPodsIfNeeded(sourceDir);
  }

  const derivedDataPath = await createRandomTmpDir();

  const buildArgs = prepareBuildArgs({
    xcodeProject,
    sourceDir,
    platform,
    scheme,
    configuration,
    deviceType,
    udid,
    derivedDataPath,
    extraParams,
  });

  p.log.info(`Xcode Build Settings:
Project        ${xcodeProject.name}
Scheme         ${scheme}
Configuration  ${configuration}
Platform       ${platform}
Device Type    ${deviceType}
Command        xcodebuild ${buildArgs.join(" ")}
`);

  const logger = createXcodebuildLogger();
  logger.start(`${xcodeProject.name} (Build)`);

  try {
    const process = execa("xcodebuild", buildArgs, {
      cwd: sourceDir,
    });

    for await (const line of process) {
      logger.processLine(line);
    }

    logger.stop("Build completed successfully");

    return await getBuildSettings({
      xcodeProject,
      sourceDir,
      platform,
      scheme,
      configuration,
      deviceType,
      udid,
      derivedDataPath,
    });
  } catch (error) {
    logger.stop("Build failed", false);
    throw new Error(`Xcode build failed: ${error}`);
  }
};

const prepareBuildArgs = ({
  xcodeProject,
  sourceDir,
  platform,
  scheme,
  configuration,
  deviceType,
  udid,
  derivedDataPath,
  extraParams,
}: {
  xcodeProject: XcodeProjectInfo;
  sourceDir: string;
  platform: ApplePlatform;
  scheme: string;
  configuration: string;
  deviceType: "device" | "simulator";
  udid?: string;
  derivedDataPath: string;
  extraParams?: string[];
}): string[] => {
  const sdk =
    deviceType === "simulator"
      ? platformConfigs[platform].simulatorSdk
      : platformConfigs[platform].deviceSdk;

  const destination = udid
    ? `id=${udid}`
    : deviceType === "simulator"
      ? platformConfigs[platform].simulatorDestination
      : platformConfigs[platform].deviceDestination;

  const args = [
    xcodeProject.isWorkspace ? "-workspace" : "-project",
    path.join(sourceDir, xcodeProject.name),
    "-scheme",
    scheme,
    "-configuration",
    configuration,
    "-sdk",
    sdk,
    "-destination",
    destination,
    "-derivedDataPath",
    derivedDataPath,
    "build",
  ];

  if (extraParams) {
    args.push(...extraParams);
  }

  return args;
};

const getBuildSettings = async ({
  xcodeProject,
  sourceDir,
  platform,
  scheme,
  configuration,
  deviceType,
  udid,
  derivedDataPath,
}: {
  xcodeProject: XcodeProjectInfo;
  sourceDir: string;
  platform: ApplePlatform;
  scheme: string;
  configuration: string;
  deviceType: AppleDeviceType;
  udid?: string;
  derivedDataPath: string;
}): Promise<{ appPath: string; infoPlistPath: string }> => {
  const sdk =
    deviceType === "simulator"
      ? platformConfigs[platform].simulatorSdk
      : platformConfigs[platform].deviceSdk;

  const destination = udid
    ? `id=${udid}`
    : deviceType === "simulator"
      ? platformConfigs[platform].simulatorDestination
      : platformConfigs[platform].deviceDestination;

  const { stdout: buildSettings } = await execa(
    "xcodebuild",
    [
      xcodeProject.isWorkspace ? "-workspace" : "-project",
      xcodeProject.name,
      "-scheme",
      scheme,
      "-configuration",
      configuration,
      "-sdk",
      sdk,
      "-destination",
      destination,
      "-derivedDataPath",
      derivedDataPath,
      "-showBuildSettings",
      "-json",
    ],
    { cwd: sourceDir },
  );

  const settings: {
    action: string;
    buildSettings: {
      TARGET_BUILD_DIR: string;
      INFOPLIST_PATH: string;
      EXECUTABLE_FOLDER_PATH: string;
      FULL_PRODUCT_NAME: string;
      WRAPPER_EXTENSION: string;
    };
    target: string;
  }[] = JSON.parse(buildSettings).filter(
    ({ target }: { target: string }) =>
      target !== "React" && target !== "React-Core",
  );

  if (settings.length === 0) {
    throw new Error("Failed to get build settings for your project");
  }

  const targetSettings = settings[0].buildSettings;
  const wrapperExtension = targetSettings.WRAPPER_EXTENSION;

  if (wrapperExtension !== "app" && wrapperExtension !== "framework") {
    throw new Error(
      `Expected wrapper extension to be "app" or "framework" but found: ${wrapperExtension}`,
    );
  }

  const targetBuildDir = targetSettings.TARGET_BUILD_DIR;
  const executableFolderPath = targetSettings.EXECUTABLE_FOLDER_PATH;
  const fullProductName = targetSettings.FULL_PRODUCT_NAME;
  const infoPlistPath = targetSettings.INFOPLIST_PATH;

  if (!targetBuildDir || !executableFolderPath || !fullProductName) {
    throw new Error("Failed to get build paths from build settings");
  }

  const appPath = path.join(targetBuildDir, executableFolderPath);

  return {
    appPath,
    infoPlistPath: path.join(targetBuildDir, infoPlistPath),
  };
};
