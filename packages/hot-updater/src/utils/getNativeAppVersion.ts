import path from "path";
import { XcodeProject } from "@bacons/xcode";
import type { Platform } from "@hot-updater/core";
import { getCwd } from "@hot-updater/plugin-core";
import { findUp } from "find-up-simple";
import fs from "fs/promises";
import { globbySync } from "globby";
import plist from "plist";

export const getNativeAppVersion = async (
  platform: Platform,
): Promise<string | null> => {
  switch (platform) {
    case "ios": {
      const iosVersion = await getIOSVersion();
      if (iosVersion) {
        return iosVersion;
      }

      const plistVersion = await getPlistVersion();
      if (plistVersion) {
        return plistVersion;
      }

      return null;
    }
    case "android":
      return getAndroidVersion();
    default:
      return null;
  }
};

const getIOSVersion = async (): Promise<string | null> => {
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

const getPlistVersion = async (): Promise<string | null> => {
  try {
    const plistPath = await findUp("Info.plist", {
      cwd: path.join(getCwd(), "ios"),
      type: "file",
    });

    if (!plistPath) {
      return null;
    }

    const file = await fs.readFile(plistPath, "utf8");
    const data = plist.parse(file) as Record<string, any>;

    return data["CFBundleShortVersionString"] ?? null;
  } catch {
    return null;
  }
};

const getAndroidVersion = async (): Promise<string | null> => {
  const buildGradlePath = path.join(getCwd(), "android", "app", "build.gradle");

  try {
    const buildGradleContent = await fs.readFile(buildGradlePath, "utf8");
    const versionNameMatch = buildGradleContent.match(
      /versionName\s+"([^"]+)"/,
    );
    return versionNameMatch?.[1] ?? null;
  } catch (error) {
    return null;
  }
};
