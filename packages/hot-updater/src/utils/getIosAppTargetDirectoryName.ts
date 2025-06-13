import path from "path";
import { getCwd } from "@hot-updater/plugin-core";
import fg from "fast-glob";

export const getIosAppTargetDirectoryName = () => {
  const iosDirectory = path.join(getCwd(), "ios");

  const [xcodeprojPath] = fg.globSync("*.xcodeproj/project.pbxproj", {
    cwd: iosDirectory,
    absolute: false,
    onlyFiles: true,
  });

  return xcodeprojPath?.split(".")?.[0] ?? null;
};
