// Credit https://github.com/callstack/rnef/blob/eb89247576934a976e8e486722c5e74f9bc068b7/packages/tools/src/lib/fingerprint/processExtraSources.ts#L14

import fs from "fs";
import path from "path";

import type { FingerprintExtraSources } from "@hot-updater/plugin-core";
import fg from "fast-glob";

type HashSourceDir = {
  type: "dir";
  filePath: string;
  reasons: string[];
};

type HashSourceContents = {
  type: "contents";
  id: string;
  contents: string | Buffer;
  reasons: string[];
};

/**
 * Resolves the extra sources that apply to a single platform.
 *
 * An array is shared by both platforms; the object form only contributes the
 * entries scoped to the requested platform.
 * @param extraSources Shared array or platform-scoped object
 * @param platform Platform the fingerprint is computed for
 * @returns Array of file paths, directory paths, or glob patterns
 */
export function resolveExtraSources(
  extraSources: FingerprintExtraSources | undefined,
  platform: "ios" | "android",
): string[] {
  if (!extraSources) {
    return [];
  }
  if (Array.isArray(extraSources)) {
    return extraSources;
  }
  return extraSources[platform] ?? [];
}

/**
 * Processes extra source files and directories for fingerprinting.
 * @param extraSources Array of file paths, directory paths, or glob patterns
 * @param cwd Current working directory for resolving paths
 * @returns Array of processed sources with their contents or directory information
 */
export function processExtraSources(extraSources: string[], cwd: string) {
  const processedSources: Array<HashSourceDir | HashSourceContents> = [];

  for (const source of extraSources) {
    try {
      const matches = fg.globSync(source, {
        cwd,
        ignore: [],
        absolute: true,
        onlyFiles: false,
      });

      for (const absolutePath of matches) {
        if (fs.existsSync(absolutePath)) {
          const stats = fs.statSync(absolutePath);
          // Convert absolute path to relative path from cwd
          // @expo/fingerprint expects relative paths, not absolute paths
          const relativePath = path.relative(cwd, absolutePath);

          if (stats.isDirectory()) {
            processedSources.push({
              type: "dir",
              filePath: relativePath,
              reasons: ["custom-user-config"],
            });
          } else {
            processedSources.push({
              type: "contents",
              id: relativePath,
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
