import { exec } from "child_process";
import path from "path";
import util from "util";
import type { Platform } from "@hot-updater/plugin-core";
import fs from "fs/promises";

const findXCodeProjectFilename = async (
  cwd: string,
): Promise<string | null> => {
  try {
    const iosDirPath = path.join(cwd, "ios");
    const dirContent = await fs.readdir(iosDirPath);
    for (const item of dirContent) {
      const itemPath = path.join(iosDirPath, item);
      const stats = await fs.stat(itemPath);
      if (stats.isDirectory()) {
        const pbxprojPath = path.join(itemPath, "project.pbxproj");
        try {
          await fs.access(pbxprojPath);
          return item;
        } catch {
          // Not the directory we are looking for
        }
      }
    }
    return null;
  } catch (error) {
    return null;
  }
};

export const getIOSVersion = async (cwd: string): Promise<string | null> => {
  const filename = await findXCodeProjectFilename(cwd);
  if (!filename) return null;

  const projectPath = path.join(cwd, "ios", filename);
  try {
    const execPromise = util.promisify(exec);

    const { stdout } = await execPromise(
      `xcodebuild -project ${projectPath} -showBuildSettings | grep MARKETING_VERSION`,
    );
    const versionMatch = stdout.match(/MARKETING_VERSION = ([\d.]+)/);
    return versionMatch?.[1] ? versionMatch[1] : null;
  } catch (error) {
    return null;
  }
};

export const getAndroidVersion = async (
  cwd: string,
): Promise<string | null> => {
  const buildGradlePath = path.join(cwd, "android", "app", "build.gradle");
  try {
    const buildGradleContent = await fs.readFile(buildGradlePath, "utf8");
    const versionNameMatch = buildGradleContent.match(
      /versionName\s+"([\d.]+)"/,
    );
    return versionNameMatch?.[1] ? versionNameMatch[1] : null;
  } catch (error) {
    return null;
  }
};

export const getDefaultTargetAppVersion = async (
  cwd: string,
  platform: Platform,
): Promise<string | null> => {
  let version: string | null = null;

  switch (platform) {
    case "ios":
      version = await getIOSVersion(cwd);
      break;
    case "android":
      version = await getAndroidVersion(cwd);
      break;
  }

  if (!version) return null;

  // If version only has one dot (e.g. 1.0), append .x
  const dotCount = version.split(".").length - 1;
  if (dotCount === 1) {
    version = `${version}.x`;
  }

  return version;
};
