import * as fs from "fs";
import * as path from "path";

/**
 * Function to check if a file with any of the given extensions exists in the specified directory.
 *
 * @param cwd - The current working directory to check in.
 * @param filename - The base name of the file (without extension).
 * @param extensions - An array of file extensions to check for.
 * @returns The resolved path if the file is found, otherwise null.
 */
export const findFileWithExtensions = (
  cwd: string,
  filename: string,
  extensions: string[],
): string | null => {
  try {
    for (const ext of extensions) {
      const fullPath = path.resolve(cwd, `${filename}${ext}`);

      if (fs.existsSync(fullPath)) {
        console.log(`File exists at: ${fullPath}`);
        return fullPath;
      }
    }

    return null;
  } catch (err) {
    return null;
  }
};
