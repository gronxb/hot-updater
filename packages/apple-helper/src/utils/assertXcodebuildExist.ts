import { colors, p } from "@hot-updater/cli-tools";
import { execa } from "execa";

export const assertXcodebuildExist = async () => {
  try {
    await execa("which", ["xcodebuild"]);
  } catch {
    p.log.error(
      `${colors.blueBright("xcodebuild")} resolve failed. Ensure that xcode is installed on your machine or xcodebuild is included in your path`,
    );
    process.exit(1);
  }
};
