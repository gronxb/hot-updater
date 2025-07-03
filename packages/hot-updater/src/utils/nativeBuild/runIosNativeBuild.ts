import path from "path";
import { type NativeBuildIosScheme, getCwd } from "@hot-updater/plugin-core";
import { injectDefaultIosNativeBuildSchemeOptions } from "./injectDefaultToNativeBuildSchemeOptions";
export const runIosNativeBuild = async ({
  schemeConfig,
}: {
  schemeConfig: NativeBuildIosScheme;
}): Promise<{ buildDirectory: string; outputFile: string }> => {
  const iosProjectRoot = path.join(getCwd(), "ios");
  const mergedConfig = injectDefaultIosNativeBuildSchemeOptions(schemeConfig);

  return { buildDirectory: "", outputFile: "" };
};
