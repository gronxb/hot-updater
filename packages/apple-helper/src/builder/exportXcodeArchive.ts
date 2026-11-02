import { prettifyXcodebuildError } from "../utils/prettifyXcodebuildError";
import { runXcodebuildWithLogging } from "../utils/runXcodebuildWithLogging";

/** Exports the archive into `exportPath`. */
export const exportXcodeArchive = async ({
  archivePath,
  exportPath,
  sourceDir,
  exportExtraParams,
  exportOptionsPlist,
  logPrefix,
  logFilePath,
  title,
  authenticationArgs,
}: {
  archivePath: string;
  /** Where the export, such as the `.ipa`, is written. */
  exportPath: string;
  /** Signing arguments from `resolveXcodeAuthenticationArgs`. */
  authenticationArgs?: string[];
  exportExtraParams?: string[];
  exportOptionsPlist: string;
  logPrefix: string;
  /** The log to append to, such as the archive's. */
  logFilePath?: string;
  /** The step's name, such as the scheme's. */
  title: string;
  sourceDir: string;
}): Promise<{ exportPath: string }> => {
  const exportArgs = prepareExportArgs({
    authenticationArgs,
    archivePath,
    exportPath,
    exportOptionsPlist,
    exportExtraParams,
  });

  try {
    await runXcodebuildWithLogging({
      args: exportArgs,
      sourceDir,
      title: `Exporting ${title}`,
      successMessage: `Exported ${title}`,
      failureMessage: "Export failed",
      logPrefix,
      logFilePath,
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
  authenticationArgs,
}: {
  archivePath: string;
  authenticationArgs?: string[];
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

  if (authenticationArgs) {
    args.push(...authenticationArgs);
  }

  if (exportExtraParams) {
    args.push(...exportExtraParams);
  }
  args.push("-exportOptionsPlist", exportOptionsPlist);
  return args;
};
