import path from "path";
import { XcodeProject } from "@bacons/xcode";
import { getCwd } from "@hot-updater/plugin-core";
import fg from "fast-glob";
import fs from "fs/promises";
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
    const [xcodeprojPath] = fg.globSync("*.xcodeproj/project.pbxproj", {
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

const IOSVersionParsers = {
  xcodeproj: getIOSVersionFromXcodeProject,
  "info-plist": getIOSVersionFromInfoPlist,
};
type IOSVersionParser = keyof typeof IOSVersionParsers;

export const getIOSVersion = async ({
  parser,
  validateWithSemver = false,
}: {
  parser: IOSVersionParser | IOSVersionParser[];
  validateWithSemver?: boolean;
}): Promise<string | null> => {
  const parsers = Array.isArray(parser) ? parser : [parser];

  for (const parserKey of parsers) {
    const parsedVersion = await IOSVersionParsers[parserKey]();

    if (!parsedVersion) continue;
    if (validateWithSemver && !semverValid(parsedVersion)) continue;

    return parsedVersion;
  }

  return null;
};
