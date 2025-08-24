import * as p from "@clack/prompts";
import { execa } from "execa";
import picocolors from "picocolors";

export const assertXcodebuildExist = async () => {
  try {
    await execa("which", ["xcodebuild"]);
  } catch {
    p.log.error(
      `${picocolors.blueBright("xcodebuild")} resolve failed. Ensure that xcode is installed on your machine or xcodebuild is included in your path`,
    );
    process.exit(1);
  }
};
