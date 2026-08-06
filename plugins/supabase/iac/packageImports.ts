import fs from "node:fs/promises";
import path from "node:path";

import { assertPathInside, resolveContainedRegularPath } from "./pathBoundary";

const staticImportSpecifierPattern =
  /^\s*(?:import|export)\s+(?:type\s+)?(?:[^"'`]+?\s+from\s+)?["']([^"']+)["'];?/gm;
const dynamicImportSpecifierPattern = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch (error) {
    const code =
      typeof error === "object" && error !== null
        ? Reflect.get(error, "code")
        : undefined;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw error;
  }
}

async function resolveLocalModulePath(
  packageRoot: string,
  fromFile: string,
  specifier: string,
): Promise<string | null> {
  const basePath = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [
    basePath,
    `${basePath}.mjs`,
    `${basePath}.js`,
    path.join(basePath, "index.mjs"),
    path.join(basePath, "index.js"),
  ];

  for (const candidate of candidates) {
    assertPathInside(packageRoot, candidate);
    if (await pathExists(candidate)) {
      return resolveContainedRegularPath(packageRoot, candidate);
    }
  }
  return null;
}

export async function collectBareImportSpecifiers(
  packageRoot: string,
  entryPath: string,
): Promise<ReadonlySet<string>> {
  const filesToVisit = [entryPath];
  const visitedFiles = new Set<string>();
  const specifiers = new Set<string>();

  while (filesToVisit.length > 0) {
    const currentFile = filesToVisit.pop();
    if (!currentFile || visitedFiles.has(currentFile)) continue;

    visitedFiles.add(currentFile);
    const source = await fs.readFile(currentFile, "utf8");
    const matches = [
      ...source.matchAll(staticImportSpecifierPattern),
      ...source.matchAll(dynamicImportSpecifierPattern),
    ];

    for (const match of matches) {
      const specifier = match[1];
      if (!specifier) continue;
      if (specifier.startsWith("./") || specifier.startsWith("../")) {
        const resolvedPath = await resolveLocalModulePath(
          packageRoot,
          currentFile,
          specifier,
        );
        if (resolvedPath) filesToVisit.push(resolvedPath);
        continue;
      }
      if (
        specifier.startsWith("node:") ||
        specifier.startsWith("npm:") ||
        specifier.startsWith("jsr:") ||
        specifier.startsWith("http://") ||
        specifier.startsWith("https://")
      ) {
        continue;
      }
      specifiers.add(specifier);
    }
  }

  return specifiers;
}
