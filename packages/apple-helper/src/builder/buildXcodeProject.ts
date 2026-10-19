import path from "path";

import { p } from "@hot-updater/cli-tools";
import type {
  ApplePlatform,
  IosBuildDestination,
} from "@hot-updater/plugin-core";
import { execa } from "execa";

import type { AppleDeviceType } from "../types";
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
import { platformConfigs } from "../utils/platform";
import { prettifyXcodebuildError } from "../utils/prettifyXcodebuildError";
import { runXcodebuildWithLogging } from "../utils/runXcodebuildWithLogging";
import {
  buildSettingsOverScheme,
  writeBuildXcconfig,
} from "../utils/writeBuildXcconfig";

export const buildXcodeProject = async ({
  sourceDir,
  platform,
  xcodeScheme,
  configuration,
  deviceType,
  logPrefix,
  destination = [],
  useGenericDestination = false,
  installPods,
  extraParams,
  minBundleId,
  authenticationArgs,
}: {
  /** Signing arguments from `resolveXcodeAuthenticationArgs`. */
  authenticationArgs?: string[];
  sourceDir: string;
  platform: ApplePlatform;
  xcodeScheme: string;
  logPrefix: string;
  configuration: string;
  deviceType: AppleDeviceType;
  destination?: IosBuildDestination[];
  useGenericDestination?: boolean;
  installPods?: boolean;
  extraParams?: string[];
  /** The MIN_BUNDLE_ID the build compiles in. */
  minBundleId: string;
}): Promise<{ appPath: string; infoPlistPath: string }> => {
  const xcodeProject = await parseXcodeProjectInfo(sourceDir);

  if (installPods) {
    await installPodsIfNeeded(sourceDir);
  }

  const derivedDataPath = await createRandomTmpDir();

  const resolvedDestinations = resolveDestinations({
    destinations: destination,
    useGeneric: useGenericDestination,
  });
  if (resolvedDestinations.length === 0) {
    resolvedDestinations.push(
      getDefaultDestination({
        deviceType,
        platform,
        useGeneric: useGenericDestination,
      }),
    );
  }

  const build = await writeBuildXcconfig({
    directory: await createRandomTmpDir(),
    sourceDir,
    extraParams,
    settings: buildSettingsOverScheme({ minBundleId, authenticationArgs }),
  });

  const buildArgs = prepareBuildArgs({
    authenticationArgs,
    xcconfig: build.xcconfig,
    minBundleId,
    configuration,
    derivedDataPath,
    deviceType,
    resolvedDestinations,
    extraParams: build.extraParams,
    platform,
    xcodeScheme,
    sourceDir,
    xcodeProject,
  });

  p.log.info(`Xcode Build Settings:
Project        ${xcodeProject.name}
Scheme         ${xcodeScheme}
Configuration  ${configuration}
Platform       ${platform}
Device Type    ${deviceType}
Command        xcodebuild ${buildArgs.join(" ")}
`);

  try {
    await runXcodebuildWithLogging({
      args: buildArgs,
      // The build setting reaches the podspec's script phase, and the
      // environment reaches Package.swift's build tool plugin, which
      // can't read build settings.
      env: { HOT_UPDATER_MIN_BUNDLE_ID: minBundleId },
      sourceDir,
      logPrefix,
      successMessage: "Build completed successfully",
      failureMessage: "Build failed",
    });

    return await getBuildSettings({
      configuration,
      derivedDataPath,
      resolvedDestinations,
      xcodeScheme,
      sourceDir,
      xcodeProject,
    });
  } catch (error) {
    throw prettifyXcodebuildError(error);
  }
};

const prepareBuildArgs = ({
  xcodeProject,
  sourceDir,
  platform,
  xcodeScheme,
  configuration,
  deviceType,
  resolvedDestinations,
  derivedDataPath,
  extraParams,
  minBundleId,
  authenticationArgs,
  xcconfig,
}: {
  authenticationArgs?: string[];
  /** From `writeBuildXcconfig`. */
  xcconfig: string;
  configuration: string;
  derivedDataPath: string;
  deviceType: AppleDeviceType;
  resolvedDestinations: string[];
  extraParams?: string[];
  minBundleId: string;
  platform: ApplePlatform;
  xcodeScheme: string;
  sourceDir: string;
  xcodeProject: XcodeProjectInfo;
}): string[] => {
  const sdk =
    deviceType === "simulator"
      ? platformConfigs[platform].simulatorSdk
      : platformConfigs[platform].deviceSdk;

  const args = [
    xcodeProject.isWorkspace ? "-workspace" : "-project",
    path.join(sourceDir, xcodeProject.name),
    "-scheme",
    xcodeScheme,
    "-configuration",
    configuration,
    "-sdk",
    sdk,
    "-derivedDataPath",
    derivedDataPath,
    `HOT_UPDATER_MIN_BUNDLE_ID=${minBundleId}`,
    "build",
  ];

  if (authenticationArgs) {
    args.push(...authenticationArgs);
  }

  args.push("-xcconfig", xcconfig);

  if (extraParams) {
    args.push(...extraParams);
  }

  for (const dest of resolvedDestinations) {
    args.push("-destination", dest);
  }

  return args;
};

const getBuildSettings = async ({
  xcodeProject,
  sourceDir,
  xcodeScheme,
  configuration,
  resolvedDestinations,
  derivedDataPath,
}: {
  configuration: string;
  derivedDataPath: string;
  resolvedDestinations: string[];
  xcodeScheme: string;
  sourceDir: string;
  xcodeProject: XcodeProjectInfo;
}): Promise<{ appPath: string; infoPlistPath: string }> => {
  const destinationArgs = resolvedDestinations.flatMap((dest) => [
    "-destination",
    dest,
  ]);

  const { stdout: buildSettings } = await execa(
    "xcodebuild",
    [
      xcodeProject.isWorkspace ? "-workspace" : "-project",
      xcodeProject.name,
      "-scheme",
      xcodeScheme,
      "-configuration",
      configuration,
      ...destinationArgs,
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
