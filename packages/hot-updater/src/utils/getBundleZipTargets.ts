import fs from "fs/promises";
import path from "path";

import type { BuildPlugin } from "@hot-updater/plugin-core";

type FilePolicy = Awaited<ReturnType<BuildPlugin["build"]>>["filePolicy"];

const getPreservedTargets = async (basePath: string, files: string[]) => {
  const base = path.resolve(basePath);
  const checkedDirectories = new Set<string>();
  const checkDirectory = async (directory: string): Promise<void> => {
    if (checkedDirectories.has(directory)) return;
    const parent = path.dirname(directory);
    if (directory !== base) await checkDirectory(parent);
    const stat = await fs.lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(
        `Build directory must not contain symbolic links: ${directory}`,
      );
    }
    checkedDirectories.add(directory);
  };
  await checkDirectory(base);

  const reserved = await fs
    .lstat(path.join(base, "manifest.json"))
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return null;
    });
  if (reserved) throw new Error("Build output contains reserved manifest.json");

  const targets: { path: string; name: string }[] = [];
  for (const file of files) {
    if (
      (path.sep !== "\\" && file.includes("\\")) ||
      file.split(/[\\/]/).includes("..")
    ) {
      throw new Error(`Invalid build artifact path: ${file}`);
    }
    const absolute = path.resolve(file);
    const relative = path.relative(base, absolute);
    if (
      !relative ||
      relative.startsWith(`..${path.sep}`) ||
      relative === ".." ||
      path.isAbsolute(relative)
    ) {
      throw new Error(`Build artifact is outside the build directory: ${file}`);
    }
    if (relative.split(path.sep)[0]?.toLowerCase() === "manifest.json") {
      throw new Error("Build output contains reserved manifest.json");
    }
    await checkDirectory(path.dirname(absolute));
    const stat = await fs.lstat(absolute);
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
      throw new Error(`Build artifact must be a regular file: ${file}`);
    }
    if (stat.isDirectory()) continue;
    targets.push({ path: absolute, name: relative.split(path.sep).join("/") });
  }
  return targets;
};

export async function getBundleZipTargets(
  basePath: string,
  files: string[],
  filePolicy?: FilePolicy,
): Promise<{ path: string; name: string }[]> {
  if (filePolicy === "preserve") return getPreservedTargets(basePath, files);
  if (filePolicy !== undefined) {
    throw new Error(`Unsupported build file policy: ${String(filePolicy)}`);
  }
  const bundleCandidates: Record<string, string> = {};
  const targets: { path: string; name: string }[] = [];

  const normalizeToPosix = (filePath: string) =>
    filePath.split(path.sep).join("/");

  const normalizedBase = normalizeToPosix(path.normalize(basePath));

  const getRelative = (file: string): string => {
    const normalizedFile = normalizeToPosix(path.normalize(file));

    if (normalizedFile.startsWith(`${normalizedBase}/`)) {
      return normalizedFile.slice(normalizedBase.length + 1);
    }
    return normalizedFile;
  };

  for (const file of files) {
    const normalizedFile = normalizeToPosix(path.normalize(file));

    if (normalizedFile.endsWith(".map")) {
      continue;
    }

    const relative = getRelative(normalizedFile);

    if (relative.endsWith(".bundle") || relative.endsWith(".bundle.hbc")) {
      let bundleBase = relative;
      if (relative.endsWith(".bundle.hbc")) {
        bundleBase = relative.slice(0, -4);
      }
      if (bundleCandidates[bundleBase]) {
        if (
          !bundleCandidates[bundleBase]?.endsWith(".hbc") &&
          normalizedFile.endsWith(".hbc")
        ) {
          bundleCandidates[bundleBase] = normalizedFile;
        }
      } else {
        bundleCandidates[bundleBase] = normalizedFile;
      }
    } else {
      targets.push({
        path: file,
        name: relative.replace(/\\/g, "/"),
      });
    }
  }

  for (const bundleBase in bundleCandidates) {
    if (!bundleCandidates[bundleBase]) continue;
    targets.push({
      path: bundleCandidates[bundleBase],
      name: bundleBase.replace(/\\/g, "/"),
    });
  }

  return targets;
}
