import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import ts from "typescript";

const request = JSON.parse(await readFile(process.argv[2], "utf8"));
const packedRoots = await Promise.all(
  request.packedRoots.map(async ({ name, root }) => ({
    name,
    root: await realpath(root),
  })),
);

const runtimeSpecifiers = (file, source) => {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.JS,
  );
  const specifiers = [];
  const visit = (node) => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isExportDeclaration(node) &&
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

const rootFor = (file) =>
  packedRoots.find(({ root }) => file.startsWith(`${root}${path.sep}`));

const normalized = (file) => {
  const packedRoot = rootFor(file);
  return packedRoot === undefined
    ? file
    : `packed:${packedRoot.name}/${path.relative(packedRoot.root, file)}`;
};

const defaultTarget = async () => {
  const packageName = request.specifier.startsWith("@")
    ? request.specifier.split("/").slice(0, 2).join("/")
    : request.specifier.split("/")[0];
  const subpath = request.specifier.slice(packageName.length);
  const packedRoot = packedRoots.find(({ name }) => name === packageName);
  if (packedRoot === undefined) {
    throw new TypeError(`Missing packed package: ${packageName}`);
  }
  const metadata = JSON.parse(
    await readFile(path.join(packedRoot.root, "package.json"), "utf8"),
  );
  let target = metadata.exports[subpath === "" ? "." : `.${subpath}`];
  while (typeof target !== "string") {
    if (typeof target !== "object" || target === null) {
      throw new TypeError(`Invalid neutral export: ${request.specifier}`);
    }
    target = target.default ?? target.import;
  }
  return pathToFileURL(path.join(packedRoot.root, target)).href;
};

const entryUrl =
  request.neutral === true
    ? await defaultTarget()
    : import.meta.resolve(request.specifier, request.parentUrl);
const entry = new URL(entryUrl);
if (entry.protocol !== "file:") {
  throw new TypeError(`Graph entry did not resolve to a file: ${entryUrl}`);
}

const pending = [fileURLToPath(entry)];
const visited = new Set();
const edges = [];
while (pending.length > 0) {
  const importer = pending.pop();
  if (importer === undefined || visited.has(importer)) {
    continue;
  }
  visited.add(importer);
  const source = await readFile(importer, "utf8");
  for (const specifier of runtimeSpecifiers(importer, source)) {
    let resolvedTarget = null;
    try {
      resolvedTarget = import.meta.resolve(
        specifier,
        pathToFileURL(importer).href,
      );
    } catch (error) {
      if (!(error instanceof Error)) {
        throw error;
      }
    }
    const resolvedFile =
      resolvedTarget?.startsWith("file:") === true
        ? fileURLToPath(resolvedTarget)
        : null;
    edges.push({
      importer: normalized(importer),
      resolvedTarget:
        resolvedFile === null ? resolvedTarget : normalized(resolvedFile),
      specifier,
    });
    if (resolvedFile !== null && rootFor(resolvedFile) !== undefined) {
      pending.push(resolvedFile);
    }
  }
}

process.stdout.write(
  JSON.stringify({ edges, entry: normalized(fileURLToPath(entry)) }),
);
