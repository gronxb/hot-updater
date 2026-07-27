import { readFile } from "node:fs/promises";
import path from "node:path";

import ts from "typescript";

import type {
  StorageGraphEdge,
  StorageGraphManifest,
} from "./storageGraphPolicy";

const compilerOptions: ts.CompilerOptions = {
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  target: ts.ScriptTarget.ES2022,
};

const hasRuntimeImport = (node: ts.ImportDeclaration): boolean => {
  const clause = node.importClause;
  if (clause === undefined) {
    return true;
  }
  if (clause.isTypeOnly) {
    return false;
  }
  if (clause.name !== undefined) {
    return true;
  }
  const bindings = clause.namedBindings;
  return (
    bindings !== undefined &&
    (ts.isNamespaceImport(bindings) ||
      bindings.elements.some((element) => !element.isTypeOnly))
  );
};

const readRuntimeSpecifiers = (
  sourceFile: ts.SourceFile,
): readonly string[] => {
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      hasRuntimeImport(node) &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isExportDeclaration(node) &&
      node.isTypeOnly !== true &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0]) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require"))
    ) {
      specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
};

const resolveSourceImport = (
  specifier: string,
  importer: string,
): string | null => {
  const resolved = ts.resolveModuleName(
    specifier,
    importer,
    compilerOptions,
    ts.sys,
  ).resolvedModule;
  return resolved?.resolvedFileName ?? null;
};

const isWorkspaceSource = (file: string, workspaceRoot: string): boolean =>
  file.startsWith(`${workspaceRoot}${path.sep}`) &&
  !file.includes(`${path.sep}node_modules${path.sep}`) &&
  !file.includes(`${path.sep}dist${path.sep}`) &&
  !file.endsWith(".d.ts") &&
  !file.endsWith(".d.mts") &&
  !file.endsWith(".d.cts");

export const createSourceGraphManifest = async (
  entry: string,
  workspaceRoot: string,
): Promise<StorageGraphManifest> => {
  const pending = [entry];
  const visited = new Set<string>();
  const edges: StorageGraphEdge[] = [];
  while (pending.length > 0) {
    const importer = pending.pop();
    if (importer === undefined || visited.has(importer)) {
      continue;
    }
    visited.add(importer);
    const source = await readFile(importer, "utf8");
    const sourceFile = ts.createSourceFile(
      importer,
      source,
      ts.ScriptTarget.ES2022,
      true,
    );
    for (const specifier of readRuntimeSpecifiers(sourceFile)) {
      const resolvedTarget = resolveSourceImport(specifier, importer);
      edges.push({ importer, resolvedTarget, specifier });
      if (
        resolvedTarget !== null &&
        isWorkspaceSource(resolvedTarget, workspaceRoot)
      ) {
        pending.push(resolvedTarget);
      }
    }
  }
  return { edges, entry };
};
