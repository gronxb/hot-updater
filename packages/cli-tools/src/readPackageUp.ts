import fs from "node:fs/promises";
import path from "node:path";

export interface ReadPackageUpResult<T = unknown> {
  packageJson: T;
  path: string;
}

const isMissingPackageJsonError = (error: unknown) => {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
};

export const readPackageUp = async <T = unknown>(
  cwd: string,
): Promise<ReadPackageUpResult<T> | undefined> => {
  let currentDir = path.resolve(cwd);

  while (true) {
    const packageJsonPath = path.join(currentDir, "package.json");

    try {
      const packageJson = JSON.parse(
        await fs.readFile(packageJsonPath, "utf-8"),
      ) as T;

      return {
        packageJson,
        path: packageJsonPath,
      };
    } catch (error) {
      if (!isMissingPackageJsonError(error)) {
        throw error;
      }
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return undefined;
    }

    currentDir = parentDir;
  }
};
