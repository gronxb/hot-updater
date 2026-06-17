import path from "path";

import {
  HOT_UPDATER_DB_SCHEMA_BASENAME,
  HOT_UPDATER_DB_SCHEMA_FILENAME,
} from "@hot-updater/core/dbSchemaArtifacts";

export { HOT_UPDATER_DB_SCHEMA_BASENAME, HOT_UPDATER_DB_SCHEMA_FILENAME };

export interface GeneratedSchemaArtifact {
  code: string;
  path: string;
}

export const resolveGeneratedSchemaOutputPath = (
  artifact: GeneratedSchemaArtifact,
  outputDir: string,
): string => {
  const artifactPath = artifact.path.trim() || HOT_UPDATER_DB_SCHEMA_FILENAME;
  if (path.isAbsolute(artifactPath)) {
    throw new Error(`Generated schema path must be relative: ${artifactPath}`);
  }

  const outputPath = path.resolve(outputDir, artifactPath);
  const relative = path.relative(outputDir, outputPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(
      `Generated schema path escapes output directory: ${artifactPath}`,
    );
  }

  return outputPath;
};
