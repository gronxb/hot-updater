import path from "path";
import type { Platform } from "@hot-updater/plugin-core";
import { findUp } from "find-up-simple";
import fs from "fs/promises";
import plist from "plist";

const getIOSVersion = async (cwd: string): Promise<string | null> => {
  try {
    const plistPath = await findUp("Info.plist", { cwd, type: "file" });
    if (!plistPath) return null;

    const file = await fs.readFile(plistPath, "utf8");
    const data = plist.parse(file) as Record<string, any>;

    return data["CFBundleShortVersionString"] ?? null;
  } catch {
    return null;
  }
};

const getAndroidVersion = async (cwd: string): Promise<string | null> => {
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
