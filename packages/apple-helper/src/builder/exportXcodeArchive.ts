import os from "os";
import path from "path";
import * as p from "@clack/prompts";
import { execa } from "execa";
import type { ExportOptions } from "./buildOptions";

const getTmpResultDir = () => path.join(os.tmpdir(), "archive");

export const exportXcodeArchive = async (
  sourceDir: string,
  options: ExportOptions,
): Promise<{ exportPath: string }> => {
  const exportPath = path.join(getTmpResultDir(), "export");
  const exportArgs = prepareExportArgs({
    exportOptions: options,
    exportPath,
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
  exportOptions: { archivePath, schemeConfig },
}: { exportOptions: ExportOptions; exportPath: string }): string[] => {
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
