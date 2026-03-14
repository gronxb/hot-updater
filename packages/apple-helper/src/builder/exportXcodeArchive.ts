import { createRandomTmpDir } from "../utils/createRandomTmpDir";
import { prettifyXcodebuildError } from "../utils/prettifyXcodebuildError";
import { runXcodebuildWithLogging } from "../utils/runXcodebuildWithLogging";

export const exportXcodeArchive = async ({
  archivePath,
  sourceDir,
  exportExtraParams,
  exportOptionsPlist,
  logPrefix,
}: {
  archivePath: string;
  exportExtraParams?: string[];
  exportOptionsPlist: string;
  logPrefix: string;
  sourceDir: string;
}): Promise<{ exportPath: string }> => {
  const exportPath = await createRandomTmpDir();
  const exportArgs = prepareExportArgs({
    archivePath,
    exportPath,
    exportOptionsPlist,
    exportExtraParams,
  });

  try {
    await runXcodebuildWithLogging({
      args: exportArgs,
      sourceDir,
      successMessage: "Archive exported successfully",
      failureMessage: "Export failed",
      logPrefix,
    });

    return { exportPath };
  } catch (error) {
    throw prettifyXcodebuildError(error);
  }
};

const prepareExportArgs = ({
  exportPath,
  archivePath,
  exportExtraParams,
  exportOptionsPlist,
}: {
  archivePath: string;
  exportExtraParams?: string[];
  exportOptionsPlist: string;
  exportPath: string;
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
