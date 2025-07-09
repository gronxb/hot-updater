import type {
  NativeBuildIosScheme,
  RequiredDeep,
} from "@hot-updater/plugin-core";
import { archive, exportArchive } from "./xcodebuild";

export const createIosNativeBuild = async ({
  schemeConfig,
}: {
  schemeConfig: RequiredDeep<NativeBuildIosScheme>;
}): Promise<{ buildDirectory: string; buildArtifactPath: string }> => {
  // const iosProjectRoot = path.join(getCwd(), "ios");

  const { archivePath } = await archive(schemeConfig);

  if (!schemeConfig.exportOptionsPlist) {
    throw new Error(
      "exportOptionsPlist is required for exporting the archive.",
    );
  }

  const { exportPath } = await exportArchive({
    archivePath,
    exportOptionsPlist: schemeConfig.exportOptionsPlist,
  });

  return { buildDirectory: exportPath, buildArtifactPath: "" };
};
