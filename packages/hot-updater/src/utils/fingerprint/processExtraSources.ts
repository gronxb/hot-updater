import fs from "node:fs";
import type { HashSourceContents, HashSourceDir } from "@expo/fingerprint";
import { globbySync } from "globby";

/**
 * Processes extra source files and directories for fingerprinting.
 * @param extraSources Array of file paths, directory paths, or glob patterns
 * @param projectRoot Root directory of the project
 * @param ignorePaths Optional array of paths to ignore
 * @returns Array of processed sources with their contents or directory information
 */
export function processExtraSources(
  extraSources: string[],
  projectRoot: string,
  ignorePaths?: string[],
) {
  const processedSources: Array<HashSourceDir | HashSourceContents> = [];

  for (const source of extraSources) {
    try {
      const matches = globbySync(source, {
        cwd: projectRoot,
        ignore: ignorePaths ?? [],
        absolute: true,
        onlyFiles: false,
      });

      for (const absolutePath of matches) {
        if (fs.existsSync(absolutePath)) {
          const stats = fs.statSync(absolutePath);
          if (stats.isDirectory()) {
            processedSources.push({
              type: "dir",
              filePath: absolutePath,
              reasons: ["custom-user-config"],
            });
          } else {
            processedSources.push({
              type: "contents",
              id: absolutePath,
              contents: fs.readFileSync(absolutePath, "utf-8"),
              reasons: ["custom-user-config"],
            });
          }
        }
      }
    } catch (error) {
      console.warn(`Error processing extra source "${source}": ${error}`);
    }
  }

  return processedSources;
}
