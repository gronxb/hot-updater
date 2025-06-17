import path from "path";
import {
  type NativeBuildArgs,
  type RequiredDeep,
  getCwd,
} from "@hot-updater/plugin-core";
import { runGradle } from "./gradle";

export const runAndroidNativeBuild = async ({
  config,
}: {
  config: RequiredDeep<NativeBuildArgs["android"]>;
}) => {
  return runGradle({
    args: {},
    artifactName: "output",
    moduleName: config.appModuleName,
    tasks: config.aab
      ? [`bundle${config.variant}`]
      : [`assemble${config.variant}`],
    cwd: path.join(getCwd(), "android"),
  });
};
