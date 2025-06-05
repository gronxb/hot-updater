import path from "path";
import { XcodeProject } from "@bacons/xcode";
import { getCwd } from "@hot-updater/plugin-core";
import fs from "fs/promises";
import { globbySync } from "globby";
import plist from "plist";
import semverValid from "semver/ranges/valid";
import { getIosAppTargetDirectoryName } from "../getIosAppTargetDirectoryName";

const isFileExist = async (path: string): Promise<boolean> => {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
};

const getIOSVersionFromInfoPlist = async (): Promise<string | null> => {
  try {
    const iosAppTargetDirectory = getIosAppTargetDirectoryName();
    if (!iosAppTargetDirectory) return null;

    const plistPath = path.join(
      getCwd(),
      "ios",
      iosAppTargetDirectory,
      "Info.plist",
    );
    if (!(await isFileExist(plistPath))) return null;

    const file = await fs.readFile(plistPath, "utf8");
    const data = plist.parse(file) as Record<string, any>;

    return data["CFBundleShortVersionString"] ?? null;
  } catch {
    return null;
  }
};

const getIOSVersionFromXcodeProject = async (): Promise<string | null> => {
  try {
    const [xcodeprojPath] = globbySync("*.xcodeproj/project.pbxproj", {
      cwd: path.join(getCwd(), "ios"),
      absolute: true,
      onlyFiles: true,
    });

    if (!xcodeprojPath) {
      return null;
    }

    const project = XcodeProject.open(xcodeprojPath).toJSON();
    const objects = project.objects ?? {};

    for (const key of Object.keys(objects)) {
      const obj = objects[key] as any;
      if (
        obj?.isa === "XCBuildConfiguration" &&
        obj?.name === "Release" &&
        typeof obj.buildSettings?.MARKETING_VERSION === "string"
      ) {
        return obj.buildSettings.MARKETING_VERSION;
      }
    }

    return null;
  } catch {
    return null;
  }
};

const Strategy = {
  xcodeproj: getIOSVersionFromXcodeProject,
  "info-plist": getIOSVersionFromInfoPlist,
};
type StrategyKey = keyof typeof Strategy;

export const getIOSVersion = async ({
  strategy,
  validateWithSemver = false,
}: {
  strategy: StrategyKey | StrategyKey[];
  validateWithSemver?: boolean;
}): Promise<string | null> => {
  const strategies = Array.isArray(strategy) ? strategy : [strategy];

  for (const strategy of strategies) {
    const parsedVersion = await Strategy[strategy]();

    if (!parsedVersion) continue;
    if (validateWithSemver && !semverValid(parsedVersion)) continue;

    return parsedVersion;
  }

  return null;
};
