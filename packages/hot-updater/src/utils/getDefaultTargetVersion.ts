import { exec } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import util from "node:util";

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
    return versionMatch ? versionMatch[1] : null;
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
    return versionNameMatch ? versionNameMatch[1] : null;
  } catch (error) {
    return null;
  }
};

export const getDefaultTargetVersion = async (
  cwd: string,
  platform: "ios" | "android",
) => {
  switch (platform) {
    case "ios":
      return getIOSVersion(cwd);
    case "android":
      return getAndroidVersion(cwd);
  }
};
