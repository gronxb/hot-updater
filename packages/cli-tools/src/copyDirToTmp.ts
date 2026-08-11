import fs from "fs/promises";
import path from "path";

import { getCwd } from "./cwd";
import { HotUpdateDirUtil } from "./HotUpdateDirUtil";

export const copyDirToTmp = async (dir: string, childDirname?: string) => {
  const cwd = getCwd();
  const hotUpdaterDir = HotUpdateDirUtil.getDirPath({ cwd });
  await fs.mkdir(hotUpdaterDir, { recursive: true });
  const tmpDir = await fs.mkdtemp(path.join(hotUpdaterDir, "tmp-"));
  const targetDir = childDirname ? path.join(tmpDir, childDirname) : tmpDir;
  await fs.cp(dir, targetDir, { recursive: true });

  return {
    tmpDir,
    removeTmpDir: () => fs.rm(tmpDir, { recursive: true, force: true }),
  };
};
