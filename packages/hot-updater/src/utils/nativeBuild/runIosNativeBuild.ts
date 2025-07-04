import type { NativeBuildIosScheme } from "@hot-updater/plugin-core";
import { injectDefaultIosNativeBuildSchemeOptions } from "./injectDefaultToNativeBuildSchemeOptions";
import { archive, exportArchive } from "./xcodebuild";

export const runIosNativeBuild = async ({
  schemeConfig,
}: {
  schemeConfig: NativeBuildIosScheme;
}): Promise<{ buildDirectory: string; outputFile: string }> => {
  // const iosProjectRoot = path.join(getCwd(), "ios");
  const mergedConfig = injectDefaultIosNativeBuildSchemeOptions(schemeConfig);

  const { archivePath } = await archive(mergedConfig);

  if (!mergedConfig.exportOptionsPlist) {
    throw new Error(
      "exportOptionsPlist is required for exporting the archive.",
    );
  }

  const { exportPath } = await exportArchive({
    archivePath,
    exportOptionsPlist: mergedConfig.exportOptionsPlist,
  });

  return { buildDirectory: exportPath, outputFile: "" };
};
