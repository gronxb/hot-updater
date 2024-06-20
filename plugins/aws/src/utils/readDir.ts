import { lstatSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";

export const readDir = async (dir: string) => {
  const files = await readdir(dir, {
    recursive: true,
  });

  return files.filter((file) => !lstatSync(path.join(dir, file)).isDirectory());
};
