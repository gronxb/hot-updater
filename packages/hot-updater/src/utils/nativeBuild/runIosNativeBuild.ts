import path from "path";
import {
  type NativeBuildArgs,
  type RequiredDeep,
  getCwd,
} from "@hot-updater/plugin-core";
export const runIosNativeBuild = async ({
  config,
}: {
  config: RequiredDeep<NativeBuildArgs["ios"]>;
}): Promise<{ buildDirectory: string; outputFile: string }> => {
  const androidProjectPath = path.join(getCwd(), "android");

  return { buildDirectory: "", outputFile: "" };
};
