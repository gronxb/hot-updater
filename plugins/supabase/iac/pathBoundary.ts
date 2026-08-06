import fs from "node:fs/promises";
import path from "node:path";

export function assertPathInside(rootPath: string, targetPath: string): void {
  const relativePath = path.relative(rootPath, targetPath);
  if (
    relativePath.length === 0 ||
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    throw new Error("Vendored package path escapes its allowed root.");
  }
}

export async function resolveContainedPath(
  rootPath: string,
  targetPath: string,
): Promise<string> {
  const [resolvedRoot, resolvedTarget] = await Promise.all([
    fs.realpath(rootPath),
    fs.realpath(targetPath),
  ]);
  assertPathInside(resolvedRoot, resolvedTarget);
  return resolvedTarget;
}

export async function resolveContainedRegularPath(
  rootPath: string,
  targetPath: string,
): Promise<string> {
  assertPathInside(path.resolve(rootPath), path.resolve(targetPath));
  if ((await fs.lstat(targetPath)).isSymbolicLink()) {
    throw new Error("Vendored package source must not contain symlinks.");
  }
  return resolveContainedPath(rootPath, targetPath);
}
