// Credit https://github.com/callstack/rock/blob/eb89247576934a976e8e486722c5e74f9bc068b7/packages/tools/src/lib/fingerprint/processExtraSources.ts#L14
import fs from "fs";
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

  // Additional ignore patterns for files that don't affect native compatibility
  const additionalIgnorePatterns = [
    // Development files
    "**/.DS_Store",
    "**/Thumbs.db",
    "**/*.log",
    
    // Build artifacts  
    "**/build/**",
    "**/dist/**",
    "**/node_modules/.cache/**",
    
    // IDE settings
    "**/.vscode/**",
    "**/.idea/**",
    "**/*.swp",
    "**/*.swo",
    
    // Temporary files
    "**/tmp/**",
    "**/temp/**",
    "**/.tmp/**",
    
    // Test files (usually don't affect native compatibility)
    "**/__tests__/**",
    "**/*.test.*",
    "**/*.spec.*",
    "**/jest.config.*",
    
    // Documentation
    "**/README*",
    "**/CHANGELOG*",
    "**/docs/**",
    "**/*.md",
    
    // Linting and formatting
    "**/.eslintrc*",
    "**/.prettierrc*",
    "**/prettier.config.*",
    "**/eslint.config.*",
  ];

  const allIgnorePatterns = [
    ...(ignorePaths ?? []),
    ...additionalIgnorePatterns,
  ];

  for (const source of extraSources) {
    try {
      const matches = fg.globSync(source, {
        cwd,
        ignore: allIgnorePatterns,
        absolute: true,
        onlyFiles: false,
      });

      for (const absolutePath of matches) {
        if (fs.existsSync(absolutePath)) {
          const stats = fs.statSync(absolutePath);
          
          // Skip if file is too large (likely binary or generated)
          if (!stats.isDirectory() && stats.size > 1024 * 1024) { // 1MB
            continue;
          }
          
          if (stats.isDirectory()) {
            processedSources.push({
              type: "dir",
              filePath: absolutePath,
              reasons: ["custom-user-config"],
            });
          } else {
            try {
              // Only read text files to avoid binary content issues
              const content = fs.readFileSync(absolutePath, "utf-8");
              processedSources.push({
                type: "contents",
                id: absolutePath,
                contents: content,
                reasons: ["custom-user-config"],
              });
            } catch (readError) {
              // Skip files that can't be read as text (likely binary)
              console.warn(`Skipping binary or unreadable file: ${absolutePath}`);
            }
          }
        }
      }
    } catch (error) {
      console.warn(`Error processing extra source "${source}": ${error}`);
    }
  }

  return processedSources;
}
