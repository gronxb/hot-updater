import path from "path";
import { XcodeProject } from "@bacons/xcode";
import type { Platform } from "@hot-updater/core";
import { getCwd } from "@hot-updater/plugin-core";
import { globbySync } from "globby";

export const getNativeAppVersion = (platform: Platform): string | null => {
  switch (platform) {
    case "ios": {
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
      } catch (error) {
        console.error("Error reading iOS app version:", error);
        return null;
      }
    }

    case "android": {
      try {
        return null; // TODO: implement Android logic
      } catch (error) {
        console.error("Error reading Android app version:", error);
        return null;
      }
    }

    default:
      return null;
  }
};
