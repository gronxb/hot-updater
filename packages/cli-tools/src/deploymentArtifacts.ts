import fs from "node:fs/promises";
import path from "node:path";

export interface DeploymentArtifact {
  readonly contents: string;
  readonly path: string;
}

export interface DeploymentArtifactWriteResult {
  readonly path: string;
  readonly status: "unchanged" | "written";
}

const compareArtifactPaths = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const normalizeArtifactPath = (artifactPath: string): string => {
  if (
    artifactPath.length === 0 ||
    artifactPath.includes("\0") ||
    artifactPath.includes("\\") ||
    path.posix.isAbsolute(artifactPath) ||
    path.win32.isAbsolute(artifactPath)
  ) {
    throw new Error(
      `Deployment artifact path must be a non-empty relative POSIX path: ${artifactPath}`,
    );
  }

  if (artifactPath.split("/").includes("..")) {
    throw new Error(
      `Deployment artifact path contains parent traversal: ${artifactPath}`,
    );
  }

  const normalizedPath = path.posix.normalize(artifactPath);
  if (
    normalizedPath === "." ||
    normalizedPath === ".." ||
    normalizedPath.startsWith("../")
  ) {
    throw new Error(
      `Deployment artifact path escapes its output directory: ${artifactPath}`,
    );
  }

  return normalizedPath;
};

export const planDeploymentArtifacts = (
  artifacts: readonly DeploymentArtifact[],
): readonly DeploymentArtifact[] => {
  const planned = artifacts.map((artifact) => ({
    contents: artifact.contents,
    path: normalizeArtifactPath(artifact.path),
  }));
  planned.sort((left, right) => compareArtifactPaths(left.path, right.path));

  const paths = new Set<string>();
  for (const artifact of planned) {
    const collisionKey = artifact.path.toLowerCase();
    if (paths.has(collisionKey)) {
      throw new Error(`Deployment artifact path collision: ${artifact.path}`);
    }
    paths.add(collisionKey);
  }

  return Object.freeze(planned.map((artifact) => Object.freeze(artifact)));
};

const isMissingPathError = (error: unknown): boolean =>
  error instanceof Error &&
  "code" in error &&
  (error as NodeJS.ErrnoException).code === "ENOENT";

const ensureSafeParentDirectory = async (
  outputDir: string,
  artifactPath: string,
): Promise<void> => {
  let currentPath = outputDir;
  for (const segment of artifactPath.split("/").slice(0, -1)) {
    currentPath = path.join(currentPath, segment);
    try {
      const entry = await fs.lstat(currentPath);
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        throw new Error(
          `Deployment artifact parent must be a directory: ${currentPath}`,
        );
      }
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      await fs.mkdir(currentPath);
    }
  }
};

export const writeDeploymentArtifacts = async ({
  artifacts,
  outputDir,
}: {
  readonly artifacts: readonly DeploymentArtifact[];
  readonly outputDir: string;
}): Promise<readonly DeploymentArtifactWriteResult[]> => {
  const planned = planDeploymentArtifacts(artifacts);
  if (planned.length === 0) return Object.freeze([]);

  const resolvedOutputDir = path.resolve(outputDir);
  await fs.mkdir(resolvedOutputDir, { recursive: true });

  const plannedWrites: Array<{
    artifact: DeploymentArtifact;
    outputPath: string;
    status: DeploymentArtifactWriteResult["status"];
  }> = [];
  for (const artifact of planned) {
    await ensureSafeParentDirectory(resolvedOutputDir, artifact.path);
    const outputPath = path.join(
      resolvedOutputDir,
      ...artifact.path.split("/"),
    );
    try {
      const entry = await fs.lstat(outputPath);
      if (entry.isSymbolicLink() || !entry.isFile()) {
        throw new Error(
          `Deployment artifact target must be a regular file: ${outputPath}`,
        );
      }
      if ((await fs.readFile(outputPath, "utf-8")) === artifact.contents) {
        plannedWrites.push({ artifact, outputPath, status: "unchanged" });
        continue;
      }
      throw new Error(`Deployment artifact path collision: ${artifact.path}`);
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
    }

    plannedWrites.push({ artifact, outputPath, status: "written" });
  }

  for (const { artifact, outputPath, status } of plannedWrites) {
    if (status === "written") {
      await fs.writeFile(outputPath, artifact.contents, "utf-8");
    }
  }

  return Object.freeze(
    plannedWrites.map(({ outputPath, status }) =>
      Object.freeze({ path: outputPath, status }),
    ),
  );
};
