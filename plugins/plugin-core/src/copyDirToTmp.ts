import path from "path";
import fs from "fs/promises";
import { getCwd } from "./cwd";

export const copyDirToTmp = async (
  dir: string,
  {
    saveDirname = ".hot-updater",
  }: {
    saveDirname?: string;
  } = {},
) => {
  const cwd = getCwd();
  const tmpDir = path.join(cwd, saveDirname);

  // Remove existing tmpDir if it exists to avoid ENOTDIR error
  try {
    await fs.rm(tmpDir, { recursive: true, force: true });
  } catch (err) {
    // Ignore errors if directory doesn't exist
  }

  await fs.mkdir(tmpDir, { recursive: true });
  await fs.cp(dir, tmpDir, { recursive: true });

  return { tmpDir, removeTmpDir: () => fs.rm(tmpDir, { recursive: true }) };
};
