import { getCwd } from "@hot-updater/cli-tools";
import fg from "fast-glob";
import path from "path";

export const getIosAppTargetDirectoryName = () => {
  const iosDirectory = path.join(getCwd(), "ios");

  const [xcodeprojPath] = fg.globSync("*.xcodeproj/project.pbxproj", {
    cwd: iosDirectory,
    absolute: false,
    onlyFiles: true,
  });

  return xcodeprojPath?.split(".")?.[0] ?? null;
};
