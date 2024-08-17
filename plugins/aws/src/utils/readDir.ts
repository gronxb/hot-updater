import { lstatSync } from "fs";
import path from "path";
import { readdir } from "fs/promises";

export const readDir = async (dir: string) => {
  const files = await readdir(dir, {
    recursive: true,
  });

  return files.filter((file) => !lstatSync(path.join(dir, file)).isDirectory());
};
