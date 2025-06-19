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
  const androidProjectPath = path.join(getCwd(), "android");

  return runGradle({
    args: {},
    appModuleName: config.appModuleName,
    tasks: config.aab
      ? [`bundle${config.variant}`]
      : [`assemble${config.variant}`],
    androidProjectPath: androidProjectPath,
  });
};
