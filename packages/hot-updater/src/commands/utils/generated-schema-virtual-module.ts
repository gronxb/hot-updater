import { lstatSync, realpathSync } from "fs";
import path from "path";
import { pathToFileURL } from "url";

import type { Jiti } from "jiti";

import { replaceGeneratedSchemaModuleSpecifiers } from "./generated-schema-importer-source";

type GeneratedSchemaVirtualModule = Readonly<{
  exports: Readonly<Record<string, unknown>>;
  id: string;
}>;

class PrismaClient {
  async $disconnect(): Promise<void> {}
}

const GENERIC_SCHEMA_MODULE = Object.freeze({});
const PRISMA_CLIENT_MODULE = Object.freeze({ PrismaClient });
const GENERIC_SCHEMA_MODULE_ID = "\0hot-updater/generated-schema/schema";
const PRISMA_CLIENT_MODULE_ID = "\0hot-updater/generated-schema/prisma";

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function resolveThroughExistingAncestor(filePath: string): string | undefined {
  let currentPath = path.resolve(filePath);
  const missingSegments: string[] = [];

  while (true) {
    try {
      return path.join(realpathSync.native(currentPath), ...missingSegments);
    } catch (error: unknown) {
      if (hasErrorCode(error, "ELOOP") || hasErrorCode(error, "ENOTDIR")) {
        return undefined;
      }
      if (!hasErrorCode(error, "ENOENT")) throw error;
      try {
        if (lstatSync(currentPath).isSymbolicLink()) return undefined;
      } catch (lstatError: unknown) {
        if (!hasErrorCode(lstatError, "ENOENT")) throw lstatError;
      }
      const parentPath = path.dirname(currentPath);
      if (parentPath === currentPath) throw error;
      missingSegments.unshift(path.basename(currentPath));
      currentPath = parentPath;
    }
  }
}

function isWithinDirectory(directory: string, filePath: string): boolean {
  const relativePath = path.relative(directory, filePath);
  return (
    relativePath !== ".." &&
    !relativePath.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relativePath)
  );
}

function hasPathSegment(filePath: string, segment: string): boolean {
  const normalizedSegment = segment.toLowerCase();
  return filePath
    .split(/[\\/]/)
    .some((pathSegment) => pathSegment.toLowerCase() === normalizedSegment);
}

function isRelativeRequest(request: string): boolean {
  return (
    request.startsWith("./") ||
    request.startsWith("../") ||
    request.startsWith(".\\") ||
    request.startsWith("..\\")
  );
}

function hasExistingModuleTarget(
  request: string,
  importerPath: string,
  jiti: Pick<Jiti, "esmResolve" | "resolve">,
): boolean {
  if (
    jiti.esmResolve(request, {
      parentURL: pathToFileURL(importerPath),
      try: true,
    }) !== undefined
  ) {
    return true;
  }
  try {
    jiti.resolve(request, { paths: [path.dirname(importerPath)] });
    return true;
  } catch (error: unknown) {
    if (hasErrorCode(error, "MODULE_NOT_FOUND")) return false;
    throw error;
  }
}

export function resolveGeneratedSchemaVirtualModule(
  request: string,
  importer: string,
  cwd: string,
  jiti: Pick<Jiti, "esmResolve" | "resolve">,
): GeneratedSchemaVirtualModule | undefined {
  if (!isRelativeRequest(request) && !path.isAbsolute(request)) {
    return undefined;
  }
  const lexicalRequestPath = path.isAbsolute(request)
    ? path.relative(path.resolve(cwd), request)
    : request;
  if (hasPathSegment(lexicalRequestPath, "node_modules")) return undefined;

  const extension = path.extname(request);
  if (extension && extension !== ".ts") return undefined;

  const projectRoot = realpathSync.native(cwd);
  const importerPath = realpathSync.native(importer);
  const resolvedTarget = path.isAbsolute(request)
    ? request
    : path.resolve(path.dirname(importerPath), request);
  const requestPath = resolveThroughExistingAncestor(resolvedTarget);
  const targetPath = resolveThroughExistingAncestor(
    extension ? resolvedTarget : `${resolvedTarget}.ts`,
  );
  if (
    !requestPath ||
    !targetPath ||
    !isWithinDirectory(projectRoot, importerPath) ||
    !isWithinDirectory(projectRoot, requestPath) ||
    !isWithinDirectory(projectRoot, targetPath) ||
    hasPathSegment(path.relative(projectRoot, requestPath), "node_modules") ||
    hasPathSegment(path.relative(projectRoot, targetPath), "node_modules") ||
    hasExistingModuleTarget(request, importerPath, jiti)
  ) {
    return undefined;
  }

  const isPrismaClient =
    path.basename(targetPath) === "prisma.ts" &&
    path.basename(path.dirname(targetPath)) === "generated";
  const isHotUpdaterSchema = path
    .basename(targetPath)
    .endsWith("hot-updater-schema.ts");
  if (!isPrismaClient && !isHotUpdaterSchema) return undefined;

  return {
    exports: isPrismaClient ? PRISMA_CLIENT_MODULE : GENERIC_SCHEMA_MODULE,
    id: isPrismaClient ? PRISMA_CLIENT_MODULE_ID : GENERIC_SCHEMA_MODULE_ID,
  };
}

export function virtualizeGeneratedSchemaImports(
  source: string,
  filename: string | undefined,
  cwd: string,
  jiti: Pick<Jiti, "esmResolve" | "resolve">,
  virtualModules: Record<string, unknown>,
  transformedProjectFiles: Set<string>,
  parseAsCommonJs = false,
): string {
  if (!filename) return source;
  const lexicalProjectRoot = path.resolve(cwd);
  const lexicalImporterPath = path.resolve(filename);
  const projectRoot = realpathSync.native(cwd);
  const importerPath = realpathSync.native(filename);
  const lexicalRelativeImporterPath = path.relative(
    lexicalProjectRoot,
    lexicalImporterPath,
  );
  const relativeImporterPath = path.relative(projectRoot, importerPath);
  const lexicalImporterIsProjectLocal = isWithinDirectory(
    lexicalProjectRoot,
    lexicalImporterPath,
  );
  if (
    !isWithinDirectory(projectRoot, importerPath) ||
    hasPathSegment(relativeImporterPath, "node_modules") ||
    hasPathSegment(
      lexicalImporterIsProjectLocal
        ? lexicalRelativeImporterPath
        : lexicalImporterPath,
      "node_modules",
    )
  ) {
    return source;
  }
  transformedProjectFiles.add(filename);
  transformedProjectFiles.add(importerPath);

  return replaceGeneratedSchemaModuleSpecifiers(
    source,
    (request) => {
      const virtualModule = resolveGeneratedSchemaVirtualModule(
        request,
        importerPath,
        projectRoot,
        jiti,
      );
      if (!virtualModule) return undefined;
      virtualModules[virtualModule.id] = virtualModule.exports;
      return virtualModule.id;
    },
    parseAsCommonJs,
  );
}
