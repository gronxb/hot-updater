import path from "path";
import { getCwd } from "@hot-updater/plugin-core";
import { globbySync } from "globby";

export const getIosAppTargetDirectoryName = () => {
  const iosDirectory = path.join(getCwd(), "ios");

  const [xcodeprojPath] = globbySync("*.xcodeproj/project.pbxproj", {
    cwd: iosDirectory,
    absolute: false,
    onlyFiles: true,
  });

  return xcodeprojPath?.split(".")?.[0] ?? null;
};
