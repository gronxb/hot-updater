import { execFile } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(import.meta.dirname, "..");

type PackedPackage = Readonly<{
  consumerRoot: string;
  root: string;
  temporaryRoot: string;
}>;

type ResolvedEntries = Readonly<{
  import: string;
  require: string;
}>;

type RuntimeGraph = Readonly<{
  files: readonly string[];
  specifiers: readonly string[];
}>;

const runtimeSpecifiers = (file: string, source: string): readonly string[] => {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.JS,
  );
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
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

const traverseRuntimeGraph = async (
  packageRootPath: string,
  entry: string,
): Promise<RuntimeGraph> => {
  const pending = [entry];
  const visited = new Set<string>();
  const specifiers = new Set<string>();
  while (pending.length > 0) {
    const file = pending.pop();
    if (file === undefined || visited.has(file)) {
      continue;
    }
    visited.add(file);
    for (const specifier of runtimeSpecifiers(
      file,
      await readFile(file, "utf8"),
    )) {
      specifiers.add(specifier);
      if (specifier.startsWith(".")) {
        const dependency = path.resolve(path.dirname(file), specifier);
        if (dependency.startsWith(`${packageRootPath}${path.sep}`)) {
          pending.push(dependency);
        }
      }
    }
  }
  return {
    files: [...visited].map((file) => path.relative(packageRootPath, file)),
    specifiers: [...specifiers],
  };
};

const resolveEntries = async (
  packed: PackedPackage,
  specifier: string,
  conditions: readonly ("edge" | "types" | "worker")[] = [],
): Promise<ResolvedEntries> => {
  const resolver = path.join(packed.consumerRoot, "resolve.mjs");
  const conditionArguments = conditions.map(
    (condition) => `--conditions=${condition}`,
  );
  const { stdout } = await execFileAsync(
    process.execPath,
    [...conditionArguments, resolver, specifier],
    { cwd: packed.consumerRoot },
  );
  const entries: unknown = JSON.parse(stdout);
  if (typeof entries !== "object" || entries === null) {
    throw new TypeError("Package resolver returned an invalid result.");
  }
  const importEntry = Reflect.get(entries, "import");
  const requireEntry = Reflect.get(entries, "require");
  if (typeof importEntry !== "string" || typeof requireEntry !== "string") {
    throw new TypeError("Package resolver did not return both module formats.");
  }
  return { import: importEntry, require: requireEntry };
};

const createPackedPackage = async (): Promise<PackedPackage> => {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "plugin-core-packed-artifact-"),
  );
  await execFileAsync("pnpm", ["run", "build"], { cwd: packageRoot });
  await execFileAsync("pnpm", ["pack", "--pack-destination", temporaryRoot], {
    cwd: packageRoot,
  });
  const archive = (await readdir(temporaryRoot)).find((file) =>
    file.endsWith(".tgz"),
  );
  if (archive === undefined) {
    throw new TypeError("Plugin-core pack did not produce an archive.");
  }
  const extractRoot = path.join(temporaryRoot, "extracted");
  await mkdir(extractRoot);
  await execFileAsync(
    "tar",
    ["-xzf", path.join(temporaryRoot, archive), "-C", extractRoot],
    { cwd: packageRoot },
  );
  const root = await realpath(path.join(extractRoot, "package"));
  const metadata: unknown = JSON.parse(
    await readFile(path.join(root, "package.json"), "utf8"),
  );
  if (typeof metadata !== "object" || metadata === null) {
    throw new TypeError("Packed plugin-core metadata is invalid.");
  }
  const dependencies = Reflect.get(metadata, "dependencies");
  if (typeof dependencies !== "object" || dependencies === null) {
    throw new TypeError("Packed plugin-core dependencies are invalid.");
  }
  const packageNodeModules = path.join(root, "node_modules");
  await mkdir(packageNodeModules);
  for (const dependency of Object.keys(dependencies)) {
    const destination = path.join(packageNodeModules, dependency);
    await mkdir(path.dirname(destination), { recursive: true });
    await symlink(
      path.join(packageRoot, "node_modules", dependency),
      destination,
      "dir",
    );
  }
  const consumerRoot = path.join(temporaryRoot, "consumer");
  const scopeRoot = path.join(consumerRoot, "node_modules", "@hot-updater");
  await mkdir(scopeRoot, { recursive: true });
  await symlink(root, path.join(scopeRoot, "plugin-core"), "dir");
  await writeFile(
    path.join(consumerRoot, "resolve.mjs"),
    [
      'import { createRequire } from "node:module";',
      "const require = createRequire(import.meta.url);",
      "process.stdout.write(JSON.stringify({",
      "  import: new URL(import.meta.resolve(process.argv[2])).pathname,",
      "  require: require.resolve(process.argv[2]),",
      "}));",
    ].join("\n"),
  );
  return { consumerRoot, root, temporaryRoot };
};

describe("packed plugin-core artifact", () => {
  let packed: PackedPackage;

  beforeAll(async () => {
    packed = await createPackedPackage();
  }, 60_000);

  afterAll(async () => {
    await rm(packed.temporaryRoot, { force: true, recursive: true });
  });

  it("keeps storage and runtime-conditioned roots free of Node compression", async () => {
    // Given a real extracted package and every target-neutral root.
    const entries = [
      await resolveEntries(packed, "@hot-updater/plugin-core/storage"),
      await resolveEntries(packed, "@hot-updater/plugin-core", ["worker"]),
      await resolveEntries(packed, "@hot-updater/plugin-core", ["edge"]),
    ];
    const typeEntries = [
      await resolveEntries(packed, "@hot-updater/plugin-core", [
        "worker",
        "types",
      ]),
      await resolveEntries(packed, "@hot-updater/plugin-core", [
        "edge",
        "types",
      ]),
    ];

    // When each ESM and CJS entry is traversed through its relative imports.
    const graphs = await Promise.all(
      entries.flatMap((entry) =>
        [entry.import, entry.require].map((file) =>
          traverseRuntimeGraph(packed.root, file),
        ),
      ),
    );

    // Then no target-neutral graph reaches the Node compression module.
    expect(graphs.flatMap((graph) => graph.files)).not.toContain(
      "dist/compressionFormat.mjs",
    );
    expect(graphs.flatMap((graph) => graph.files)).not.toContain(
      "dist/compressionFormat.cjs",
    );
    expect(graphs.flatMap((graph) => graph.specifiers)).not.toContain(
      "node:path",
    );
    expect(
      typeEntries.map((entry) => path.relative(packed.root, entry.import)),
    ).toEqual(["dist/runtime.d.mts", "dist/runtime.d.mts"]);
    expect(
      typeEntries.map((entry) => path.relative(packed.root, entry.require)),
    ).toEqual(["dist/runtime.d.cts", "dist/runtime.d.cts"]);
  });

  it("preserves root compression behavior in ESM and CJS", async () => {
    // Given the default root entries from the extracted package.
    const entries = await resolveEntries(packed, "@hot-updater/plugin-core");

    // When compression APIs are loaded through both module formats.
    const esm = await import(pathToFileURL(entries.import).href);
    const cjs = createRequire(import.meta.url)(entries.require);

    // Then both retain the legacy format and content-type results.
    expect(esm.detectCompressionFormat("bundle.tar.br")).toEqual({
      fileExtension: ".tar.br",
      format: "tar.br",
      mimeType: "application/x-tar",
    });
    expect(cjs.detectCompressionFormat("bundle.tar.gz")).toEqual({
      fileExtension: ".tar.gz",
      format: "tar.gz",
      mimeType: "application/x-tar",
    });
    expect(esm.getContentType("/tmp/bundle.zip")).toBe("application/zip");
    expect(cjs.getContentType("C:\\tmp\\bundle.zip")).toBe("application/zip");
  });
});
