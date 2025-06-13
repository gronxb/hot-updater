// Credit https://github.com/callstack/rnef/blob/eb89247576934a976e8e486722c5e74f9bc068b7/packages/tools/src/lib/fingerprint/processExtraSources.ts#L14
import fs from "node:fs";
import type { HashSourceContents, HashSourceDir } from "@expo/fingerprint";
import fg from "fast-glob";

/**
 * Processes extra source files and directories for fingerprinting.
 * @param extraSources Array of file paths, directory paths, or glob patterns
 * @param cwd Current working directory for resolving paths
 * @param ignorePaths Optional array of paths to ignore
 * @returns Array of processed sources with their contents or directory information
 */
export function processExtraSources(
  extraSources: string[],
  cwd: string,
  ignorePaths?: string[],
) {
  const processedSources: Array<HashSourceDir | HashSourceContents> = [];

  for (const source of extraSources) {
    try {
      const matches = fg.globSync(source, {
        cwd,
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
