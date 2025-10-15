import * as p from "@clack/prompts";
import { execa } from "execa";
import { createRandomTmpDir } from "../utils/createRandomTmpDir";
import { prettifyXcodebuildError } from "./prettifyXcodebuildError";

export const exportXcodeArchive = async ({
  archivePath,
  sourceDir,
  exportExtraParams,
  exportOptionsPlist,
}: {
  sourceDir: string;
  archivePath: string;
  exportOptionsPlist: string;
  exportExtraParams?: string[];
}): Promise<{ exportPath: string }> => {
  const exportPath = await createRandomTmpDir();
  const exportArgs = prepareExportArgs({
    archivePath,
    exportPath,
    exportOptionsPlist,
    exportExtraParams,
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
    throw prettifyXcodebuildError(error);
  }
};

const prepareExportArgs = ({
  exportPath,
  archivePath,
  exportExtraParams,
  exportOptionsPlist,
}: {
  exportPath: string;
  archivePath: string;
  exportOptionsPlist: string;
  exportExtraParams?: string[];
}): string[] => {
  const args = [
    "-exportArchive",
    "-archivePath",
    archivePath,
    "-exportPath",
    exportPath,
  ];

  if (exportExtraParams) {
    args.push(...exportExtraParams);
  }
  args.push("-exportOptionsPlist", exportOptionsPlist);
  return args;
};
