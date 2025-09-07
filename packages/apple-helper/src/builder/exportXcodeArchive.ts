import os from "os";
import path from "path";
import * as p from "@clack/prompts";
import type { NativeBuildIosScheme } from "@hot-updater/plugin-core";
import { execa } from "execa";

const getTmpResultDir = () => path.join(os.tmpdir(), "export");

export const exportXcodeArchive = async ({
  archivePath,
  schemeConfig,
  sourceDir,
}: {
  sourceDir: string;
  schemeConfig: NativeBuildIosScheme;
  archivePath: string;
}): Promise<{ exportPath: string }> => {
  const exportPath = path.join(getTmpResultDir(), "export");
  const exportArgs = prepareExportArgs({
    archivePath,
    exportPath,
    schemeConfig,
  });

  const spinner = p.spinner();
  spinner.start("Exporting archive to IPA");

  try {
    await execa("xcodebuild", exportArgs, {
      cwd: sourceDir,
    });

    spinner.stop("Archive exported successfully");
    return { exportPath };
  } catch (error) {
    spinner.stop("Export failed");
    throw new Error(`Archive export failed: ${error}`);
  }
};

const prepareExportArgs = ({
  exportPath,
  archivePath,
  schemeConfig,
}: {
  exportPath: string;
  archivePath: string;
  schemeConfig: NativeBuildIosScheme;
}): string[] => {
  const args = [
    "-exportArchive",
    "-archivePath",
    archivePath,
    "-exportPath",
    exportPath,
  ];

  if (schemeConfig.exportExtraParams) {
    args.push(...schemeConfig.exportExtraParams);
  }
  if (schemeConfig.exportOptionsPlist) {
    args.push("-exportOptionsPlist", schemeConfig.exportOptionsPlist);
  }
  return args;
};
