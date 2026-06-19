import path from "path";

export const DEFAULT_GENERATED_SCHEMA_FILENAME = "hot-updater-schema.ts";

export interface GeneratedSchemaArtifact {
  code: string;
  path: string;
}

export const resolveGeneratedSchemaOutputPath = (
  artifact: GeneratedSchemaArtifact,
  outputDir: string,
): string => {
  const artifactPath =
    artifact.path.trim() || DEFAULT_GENERATED_SCHEMA_FILENAME;
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
