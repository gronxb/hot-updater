import { lstatSync } from "fs";
import { readdir } from "fs/promises";
import path from "path";

export const readDir = async (dir: string) => {
  const files = await readdir(dir, {
    recursive: true,
  });

  return files.filter((file) => !lstatSync(path.join(dir, file)).isDirectory());
};
