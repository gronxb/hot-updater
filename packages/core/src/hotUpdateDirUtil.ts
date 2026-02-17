import path from "path";

const HOT_UPDATE_DIR_NAME = ".hot-updater";
const HOT_UPDATE_OUTPUT_DIR_NAME = "output";
const HOT_UPDATE_LOG_DIR_NAME = "log";

export const HotUpdateDirUtil = {
  dirName: HOT_UPDATE_DIR_NAME,
  outputDirName: HOT_UPDATE_OUTPUT_DIR_NAME,
  logDirName: HOT_UPDATE_LOG_DIR_NAME,
  outputGitignorePath: `${HOT_UPDATE_DIR_NAME}/${HOT_UPDATE_OUTPUT_DIR_NAME}`,
  logGitignorePath: `${HOT_UPDATE_DIR_NAME}/${HOT_UPDATE_LOG_DIR_NAME}`,
  getDirPath: ({ cwd }: { cwd: string }) => {
    return path.join(cwd, HOT_UPDATE_DIR_NAME);
  },
  getDefaultOutputPath: ({ cwd }: { cwd: string }) => {
    return path.join(cwd, HOT_UPDATE_DIR_NAME, HOT_UPDATE_OUTPUT_DIR_NAME);
  },
  getLogDirPath: ({ cwd }: { cwd: string }) => {
    return path.join(cwd, HOT_UPDATE_DIR_NAME, HOT_UPDATE_LOG_DIR_NAME);
  },
} as const;
