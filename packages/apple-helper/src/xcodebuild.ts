import path from "path";
import * as p from "@clack/prompts";
import { type NativeBuildIosScheme, getCwd } from "@hot-updater/plugin-core";
import { execa } from "execa";
import fs from "fs/promises";
import picocolors from "picocolors";

export const ensureXcodebuildExist = async () => {
  try {
    await execa("which", ["xcodebuild"]);
  } catch {
    p.log.error(
      `${picocolors.blueBright("xcodebuild")} resolve failed. Ensure that xcode is installed on your machine or xcodebuild is included in your path`,
    );
    process.exit(1);
  }
};

const getProjectInfo = async () => {
  const iosPath = path.join(getCwd(), "ios");
  const files = await fs.readdir(iosPath);

  const workspace = files.find((file) => file.endsWith(".xcworkspace"));
  const project = files.find((file) => file.endsWith(".xcodeproj"));

  if (!workspace || !project) {
    throw new Error(
      "Could not find .xcworkspace or .xcodeproj file in ios directory",
    );
  }

  return {
    workspace,
    project,
  };
};

export const archive = async (
  options: Required<Omit<NativeBuildIosScheme, "exportOptionsPlist">>,
) => {
  const { scheme, buildConfiguration, sdk, destination, xcconfig } = options;
  const { workspace } = await getProjectInfo();
  const archivePath = path.join(
    getCwd(),
    "ios",
    "build",
    `${scheme}.xcarchive`,
  );

  const args = [
    "-workspace",
    path.join(getCwd(), "ios", workspace),
    "-scheme",
    scheme,
    "-configuration",
    buildConfiguration,
    "archive",
    "-archivePath",
    archivePath,
  ];

  if (xcconfig) {
    args.push("-xcconfig", xcconfig);
  }

  await execa("xcodebuild", args, { stdio: "inherit" });

  return { archivePath };
};

export const build = async (
  options: Required<Omit<NativeBuildIosScheme, "exportOptionsPlist">>,
) => {
  const { scheme, buildConfiguration, sdk, destination, xcconfig } = options;
  const { workspace } = await getProjectInfo();

  const args = [
    "-workspace",
    path.join(getCwd(), "ios", workspace),
    "-scheme",
    scheme,
    "-sdk",
    sdk,
    "-destination",
    destination,
    "-configuration",
    buildConfiguration,
    "build",
  ];

  if (xcconfig) {
    args.push("-xcconfig", xcconfig);
  }

  await execa("xcodebuild", args, { stdio: "inherit" });
};

export const exportArchive = async (options: {
  archivePath: string;
  exportOptionsPlist: string;
}) => {
  const { archivePath, exportOptionsPlist } = options;
  const exportPath = path.join(getCwd(), "ios", "build");

  const args = [
    "-exportArchive",
    "-archivePath",
    archivePath,
    "-exportPath",
    exportPath,
    "-exportOptionsPlist",
    exportOptionsPlist,
  ];

  await execa("xcodebuild", args, { stdio: "inherit" });

  return { exportPath };
};
