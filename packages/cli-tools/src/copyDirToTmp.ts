import fs from "fs/promises";
import path from "path";
import { getCwd } from "./cwd";

export const copyDirToTmp = async (dir: string, childDirname?: string) => {
  const cwd = getCwd();
  const hotUpdaterDir = path.join(cwd, ".hot-updater");
  const tmpDir = childDirname
    ? path.join(hotUpdaterDir, childDirname)
    : hotUpdaterDir;

  // Remove existing tmpDir if it exists to avoid ENOTDIR error
  try {
    await fs.rm(tmpDir, { recursive: true, force: true });
  } catch {
    // Ignore errors if directory doesn't exist
  }

  await fs.mkdir(tmpDir, { recursive: true });
  await fs.cp(dir, tmpDir, { recursive: true });

  return {
    tmpDir: hotUpdaterDir,
    removeTmpDir: () => fs.rm(hotUpdaterDir, { recursive: true }),
  };
};
