/**
 * The acceptance report (PRD "Final acceptance"): measures every manifest row
 * against S1–S7 and redraws the implementation table. A row that fails a
 * check shows that check instead of Smooth, and the script exits 1. S6 is
 * complexity (no function above cyclomatic 20) and S7 over-fetching (no
 * `limit + 1`, no filtered `findMany` results) in the row's code. Two checks
 * outside the rows fail the run too: request paths (server, console, and
 * plugins) have no over-fetching, and the storage engine layer as a whole
 * passes S1. It also prints each row's native read multiplier.
 *
 *   pnpm acceptance [--run | --results <vitest json>...] [--commit <sha>] [--json <file>]
 *
 * S3 and S4 read a vitest JSON report of the manifest's suites: `--run`
 * runs them first (the integration environment: Docker, and Java 21 for the
 * Firebase emulator, as `mise exec java@temurin-21 -- pnpm acceptance --run`),
 * and `--results` reads earlier reports, such as one from `pnpm test` and one
 * from `pnpm test:integration`. Without either they fail as not run. S5 reads plans/evidence/database-redesign-e2e.json.
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { parseSync } from "oxc-parser";
import { format } from "oxfmt";

import {
  type AcceptanceRow,
  domainImports,
  genericFieldNames,
  layers,
  rows,
} from "./manifest.mts";

const root = path.resolve(import.meta.dirname, "../..");
const relative = (file: string) => path.relative(root, file);

const { values: args } = parseArgs({
  options: {
    run: { type: "boolean" },
    results: { type: "string", multiple: true },
    commit: { type: "string" },
    json: { type: "string" },
  },
});

/** The S3 cases every adapter's conformance suite must pass. */
const ATOMICITY_CASES = [
  "applies nothing when an op at any position fails",
  "lets exactly one of 32 concurrent writers win a contested key",
  "loses no increments under 32 concurrent writers",
  "rejects write skew between two checked writers",
  "refuses a duplicate on a unique index with the failing op",
];
const OVER_LIMIT_CASE = "rejects an over-limit write before sending it";
const PAGE_CAP_CASE = "fills every page when native pages are capped";
const EVIDENCE = "plans/evidence/database-redesign-e2e.json";
/** Profiles on a managed runtime, whose evidence names the deployed runtime. */
const MANAGED_PROFILES = new Set(["supabase", "cloudflare", "firebase", "aws"]);
/** S6: the highest cyclomatic complexity a function may have (ESLint's default). */
const MAX_COMPLEXITY = 20;

type Node = { type: string; start: number; [key: string]: unknown };

interface SourceFile {
  readonly file: string;
  readonly source: string;
  readonly program: Node;
  readonly comments: readonly { start: number; end: number }[];
  readonly imports: readonly string[];
}

const parse = (file: string, source: string): SourceFile => {
  const result = parseSync(file, source, { sourceType: "module" });
  if (result.errors.length > 0) {
    throw new Error(`${relative(file)}: ${result.errors[0]!.message}`);
  }
  const imports: string[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== "object") return;
    const value = node as Node;
    const source = value.source as { value?: unknown } | undefined;
    if (
      (value.type === "ImportDeclaration" ||
        value.type === "ExportNamedDeclaration" ||
        value.type === "ExportAllDeclaration" ||
        value.type === "ImportExpression") &&
      typeof source?.value === "string"
    ) {
      imports.push(source.value);
    }
    if (value.type === "TSImportType") {
      const argument = (value.argument ?? value.source) as
        | { value?: unknown; literal?: { value?: unknown } }
        | undefined;
      const name = argument?.literal?.value ?? argument?.value;
      if (typeof name === "string") imports.push(name);
    }
    for (const child of Object.values(value)) visit(child);
  };
  visit(result.program);
  return {
    file,
    source,
    program: result.program as unknown as Node,
    comments: result.comments,
    imports,
  };
};

const resolveRelative = (from: string, specifier: string) => {
  const base = path.resolve(path.dirname(from), specifier);
  return [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, "index.ts"),
    base.replace(/\.m?js$/, ".ts"),
  ].find((file) => existsSync(file) && statSync(file).isFile());
};

const matches = (file: string, globs: readonly string[]) =>
  globs.some((glob) => path.matchesGlob(relative(file), glob));

/** `@hot-updater/server` subpaths by their source entry: the package builds `src/` unbundled into `dist/`. */
const serverEntries = (() => {
  const { exports } = JSON.parse(
    readFileSync(path.join(root, "packages/server/package.json"), "utf8"),
  ) as { exports: Record<string, string | { import?: string }> };
  return new Map(
    Object.entries(exports).flatMap(([subpath, target]) => {
      const file = typeof target === "string" ? undefined : target.import;
      if (!file?.startsWith("./dist/")) return [];
      const source = file.replace("./dist/", "src/").replace(/\.mjs$/, ".ts");
      return [
        [
          `@hot-updater/server${subpath.slice(1)}`,
          path.join(root, "packages/server", source),
        ],
      ];
    }),
  );
})();

/** A domain package import (S1), named by its specifier. */
const isDomainPackage = (specifier: string) =>
  domainImports.packages.some((pattern) =>
    path.matchesGlob(specifier, pattern),
  );

/** The row's files: its entries and every relative import short of shared code. */
const graphOf = (row: AcceptanceRow) => {
  const files = new Map<string, SourceFile>();
  const external: { file: string; specifier: string }[] = [];
  const pending = row.entries.map((entry) => path.join(root, entry));
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (files.has(file)) continue;
    if (!existsSync(file))
      throw new Error(`${row.name}: ${relative(file)} is missing`);
    const parsed = parse(file, readFileSync(file, "utf8"));
    files.set(file, parsed);
    for (const specifier of parsed.imports) {
      const relativeImport = specifier.startsWith(".");
      if (
        !relativeImport &&
        (isDomainPackage(specifier) || !serverEntries.has(specifier))
      ) {
        external.push({ file, specifier });
        continue;
      }
      const target = relativeImport
        ? resolveRelative(file, specifier)
        : serverEntries.get(specifier);
      if (!target)
        throw new Error(`${relative(file)}: cannot resolve ${specifier}`);
      if (matches(target, domainImports.files)) {
        external.push({ file, specifier: relative(target) });
      } else if (!matches(target, row.shared)) {
        pending.push(target);
      }
    }
  }
  return { files: [...files.values()], external };
};

const lineOf = (source: string, offset: number) =>
  source.slice(0, offset).split("\n").length;

/** Model, table, and non-generic field names of the built-in schema. */
const domainNames = async () => {
  const entry = path.join(root, "packages/server/dist/database/index.mjs");
  if (!existsSync(entry)) throw new Error("Run `pnpm build` first");
  const { builtInSchema } = (await import(pathToFileURL(entry).href)) as {
    builtInSchema: {
      models: Map<
        string,
        { table: { name: string; columns: readonly { name: string }[] } }
      >;
    };
  };
  const names = new Set<string>();
  for (const [name, model] of builtInSchema.models) {
    names.add(name);
    names.add(model.table.name);
    for (const column of model.table.columns) {
      // Engine columns name no domain concept; `_refs_*` counters do.
      if (column.name === "_v" || column.name === "_shard") continue;
      if (!genericFieldNames.includes(column.name)) names.add(column.name);
    }
  }
  return names;
};

/** A table: `table`, `SETTINGS_TABLE`, `rowsTable`, or `<x>.table`. */
const isTableObject = (node: unknown): boolean => {
  const value = node as
    | (Node & { name?: string; computed?: boolean })
    | undefined;
  const isTableWord = (name: string | undefined) =>
    name !== undefined && /^table$|Table$|(^|_)TABLE$/.test(name);
  return (
    (value?.type === "Identifier" && isTableWord(value.name)) ||
    (value?.type === "MemberExpression" &&
      !value.computed &&
      isTableWord((value.property as { name?: string }).name))
  );
};

/** A table's name: `<table>.name`, or a name bound to one in the same file. */
const isTableName = (
  node: unknown,
  aliases: ReadonlySet<string> = new Set(),
): boolean => {
  const value = unwrap(node) as (Node & { name?: string }) | undefined;
  if (value?.type === "Identifier") return aliases.has(value.name!);
  if (value?.type !== "MemberExpression" || value.computed) return false;
  if ((value.property as Node & { name?: string }).name !== "name")
    return false;
  return isTableObject(value.object);
};

/** Names a file binds to a table's name: `const n = table.name`, `const { name } = table`. */
const tableNameAliases = (program: Node) => {
  const aliases = new Set<string>();
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== "object") return;
    const value = node as Node;
    if (value.type === "VariableDeclarator") {
      const id = value.id as Node & {
        name?: string;
        properties?: (Node & {
          key?: { name?: string };
          value?: Node & { name?: string };
        })[];
      };
      if (id.type === "Identifier" && isTableName(value.init)) {
        aliases.add(id.name!);
      }
      if (id.type === "ObjectPattern" && isTableObject(unwrap(value.init))) {
        for (const property of id.properties ?? []) {
          if (
            property.type === "Property" &&
            property.key?.name === "name" &&
            property.value?.type === "Identifier"
          ) {
            aliases.add(property.value.name!);
          }
        }
      }
    }
    for (const [key, child] of Object.entries(value)) {
      if (key !== "start" && key !== "end") visit(child);
    }
  };
  visit(program);
  return aliases;
};

/** Names a module declares at its top level: fixed collections, when they hold tables. */
const moduleConstants = (program: Node) => {
  const names = new Set<string>();
  for (const statement of program.body as Node[]) {
    const declaration =
      statement.type === "ExportNamedDeclaration"
        ? (statement.declaration as Node | null)
        : statement;
    if (declaration?.type !== "VariableDeclaration") continue;
    for (const declarator of declaration.declarations as Node[]) {
      const id = declarator.id as { type: string; name?: string };
      if (id.type === "Identifier") names.add(id.name!);
    }
  }
  return names;
};

type Binding = "string" | "strings";

const unwrap = (node: unknown): Node | undefined => {
  let value = node as Node | undefined;
  while (
    value?.type === "TSAsExpression" ||
    value?.type === "TSSatisfiesExpression"
  ) {
    value = value.expression as Node;
  }
  return value;
};

const isStringLiteral = (node: unknown) => {
  const value = unwrap(node);
  return (
    (value?.type === "Literal" && typeof value.value === "string") ||
    value?.type === "TemplateLiteral"
  );
};

/** Names bound to a string, or to a list or set of strings, in one file. */
const literalBindings = (program: Node) => {
  const bindings = new Map<string, Binding>();
  /** A fixed collection: a non-empty array or Set literal. An empty one filled later is not. */
  const strings = (node: unknown) => {
    const value = unwrap(node);
    const list =
      value?.type === "NewExpression" &&
      (value.callee as { name?: string }).name === "Set"
        ? unwrap((value.arguments as unknown[])[0])
        : value;
    return (
      list?.type === "ArrayExpression" &&
      (list.elements as unknown[]).length > 0
    );
  };
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== "object") return;
    const value = node as Node;
    const id = value.id as { type?: string; name?: string } | undefined;
    if (value.type === "VariableDeclarator" && id?.type === "Identifier") {
      if (isStringLiteral(value.init)) bindings.set(id.name!, "string");
      else if (strings(value.init)) bindings.set(id.name!, "strings");
    }
    for (const [key, child] of Object.entries(value)) {
      if (key !== "start" && key !== "end") visit(child);
    }
  };
  visit(program);
  return bindings;
};

/** S1: no domain imports, no domain names as literals, no branches on `table.name`. */
const boundary = (
  graph: ReturnType<typeof graphOf>,
  names: ReadonlySet<string>,
) => {
  const violations: string[] = [];
  for (const { file, specifier } of graph.external) {
    if (
      matches(path.join(root, specifier), domainImports.files) ||
      isDomainPackage(specifier)
    ) {
      violations.push(`${relative(file)} imports ${specifier}`);
    }
  }
  for (const { file, source, program } of graph.files) {
    const at = (node: Node) =>
      `${relative(file)}:${lineOf(source, node.start)}`;
    const bindings = literalBindings(program);
    const aliases = tableNameAliases(program);
    const constants = moduleConstants(program);
    const tableName = (node: unknown) => isTableName(node, aliases);
    /** A string, or a name bound to one: comparing table.name with it singles a table out. */
    const constant = (node: unknown) => {
      const value = unwrap(node) as (Node & { name?: string }) | undefined;
      return (
        value?.type === "Identifier" &&
        (constants.has(value.name!) || /^[A-Z][A-Z0-9_]*$/.test(value.name!))
      );
    };
    const named = (node: unknown) => {
      const value = unwrap(node) as (Node & { name?: string }) | undefined;
      return (
        isStringLiteral(value) ||
        (value?.type === "Identifier" &&
          (bindings.get(value.name!) === "string" || constant(value))) ||
        // Another table's name, when that table is a constant: SETTINGS_TABLE.name.
        (value?.type === "MemberExpression" &&
          isTableName(value) &&
          constant(value.object))
      );
    };
    const visit = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(visit);
      if (!node || typeof node !== "object") return;
      const value = node as Node;
      const literal = (text: unknown) => {
        if (typeof text === "string" && names.has(text)) {
          violations.push(`${at(value)} names "${text}"`);
        }
      };
      switch (value.type) {
        case "Literal":
          literal(value.value);
          break;
        case "TemplateElement":
          literal((value.value as { cooked?: string }).cooked);
          break;
        case "Identifier":
          break;
        case "Property":
        case "PropertyDefinition":
        case "TSPropertySignature":
        case "MemberExpression": {
          const key = (value.key ?? value.property) as Node & { name?: string };
          if (!value.computed && key.type === "Identifier") literal(key.name);
          break;
        }
        case "BinaryExpression":
          if (
            ["===", "!==", "==", "!="].includes(value.operator as string) &&
            ((tableName(value.left) && named(value.right)) ||
              (tableName(value.right) && named(value.left)))
          ) {
            violations.push(`${at(value)} branches on table.name`);
          }
          break;
        case "SwitchStatement":
          if (
            tableName(value.discriminant) &&
            (value.cases as { test?: unknown }[]).some(({ test }) =>
              named(test),
            )
          ) {
            violations.push(`${at(value)} branches on table.name`);
          }
          break;
        case "CallExpression": {
          const callee = value.callee as Node & {
            object?: Node & { name?: string };
            property?: { name?: string };
          };
          const list = unwrap(callee.object) as
            | (Node & { name?: string; regex?: unknown })
            | undefined;
          const method = callee.property?.name ?? "";
          const args = value.arguments as unknown[];
          if (callee.type !== "MemberExpression") break;
          // A fixed collection of tables: literal names, or a module-level constant.
          const membership =
            ["has", "includes"].includes(method) &&
            tableName(args[0]) &&
            ((list?.type === "Identifier" &&
              (bindings.get(list.name!) === "strings" ||
                constants.has(list.name!))) ||
              list?.type === "ArrayExpression");
          // A string test on the name: startsWith, endsWith, a regex.
          const inspection =
            (["startsWith", "endsWith", "includes", "match", "search"].includes(
              method,
            ) &&
              tableName(list) &&
              args.some(named)) ||
            (method === "test" &&
              list?.type === "Literal" &&
              list.regex !== undefined &&
              tableName(args[0]));
          if (membership || inspection) {
            violations.push(`${at(value)} branches on table.name`);
          }
          break;
        }
      }
      for (const [key, child] of Object.entries(value)) {
        if (key !== "start" && key !== "end") visit(child);
      }
    };
    visit(program);
  }
  return violations;
};

const formatOptions = (() => {
  const {
    $schema: _,
    ignorePatterns: __,
    ...options
  } = JSON.parse(readFileSync(path.join(root, ".oxfmtrc.json"), "utf8"));
  return options;
})();

/** Non-blank lines holding code outside comments. */
const countLines = (file: SourceFile) => {
  const comment = new Uint8Array(file.source.length);
  for (const { start, end } of file.comments) comment.fill(1, start, end);
  let lines = 0;
  let code = false;
  for (let index = 0; index <= file.source.length; index += 1) {
    const char = file.source[index];
    if (char === undefined || char === "\n") {
      if (code) lines += 1;
      code = false;
    } else if (!comment[index] && !/\s/.test(char)) {
      code = true;
    }
  }
  return lines;
};

/** S2: lines after oxfmt across the row's graph. */
const size = async (graph: ReturnType<typeof graphOf>) => {
  const files: { file: string; lines: number; formatted: boolean }[] = [];
  for (const file of graph.files) {
    const result = await format(file.file, file.source, formatOptions);
    if (result.errors.length > 0)
      throw new Error(`${relative(file.file)}: oxfmt failed`);
    files.push({
      file: relative(file.file),
      lines: countLines(parse(file.file, result.code)),
      formatted: result.code === file.source,
    });
  }
  files.sort((left, right) => right.lines - left.lines);
  return { lines: files.reduce((sum, file) => sum + file.lines, 0), files };
};

const FUNCTIONS = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);
const DECISIONS = new Set([
  "IfStatement",
  "ConditionalExpression",
  "ForStatement",
  "ForInStatement",
  "ForOfStatement",
  "WhileStatement",
  "DoWhileStatement",
  "CatchClause",
]);

/**
 * S6: cyclomatic complexity of each function in the row's graph: 1, plus one
 * per branch, loop, catch, case, and `&&`, `||`, or `??`; nested functions
 * count on their own. No function may score above MAX_COMPLEXITY.
 */
const complexity = (graph: ReturnType<typeof graphOf>) => {
  const functions: { at: string; score: number }[] = [];
  for (const { file, source, program } of graph.files) {
    const score = (node: unknown, own: { score: number }): void => {
      if (Array.isArray(node))
        return node.forEach((child) => score(child, own));
      if (!node || typeof node !== "object") return;
      const value = node as Node;
      if (FUNCTIONS.has(value.type)) {
        const inner = { score: 1 };
        score(value.body, inner);
        functions.push({
          at: `${relative(file)}:${lineOf(source, value.start)}`,
          score: inner.score,
        });
        return;
      }
      if (DECISIONS.has(value.type)) own.score += 1;
      if (value.type === "SwitchCase" && value.test) own.score += 1;
      if (
        (value.type === "LogicalExpression" ||
          value.type === "AssignmentExpression") &&
        ["&&", "||", "??", "&&=", "||=", "??="].includes(
          value.operator as string,
        )
      ) {
        own.score += 1;
      }
      for (const [key, child] of Object.entries(value)) {
        if (key !== "start" && key !== "end") score(child, own);
      }
    };
    score(program, { score: 0 });
  }
  functions.sort((left, right) => right.score - left.score);
  return {
    functions: functions.length,
    max: functions[0],
    over: functions.filter((fn) => fn.score > MAX_COMPLEXITY),
  };
};

/** Request-path code: the server, the console, and every plugin's source, without tests. */
const requestPathFiles = () =>
  ["packages/server/src", "packages/console/src", "plugins"].flatMap((dir) =>
    (readdirSync(path.join(root, dir), { recursive: true }) as string[])
      .filter(
        (file) =>
          /\.tsx?$/.test(file) &&
          !/\.(spec|test)\.tsx?$|\.d\.ts$/.test(file) &&
          !/(^|\/)(node_modules|dist|lib|build)\//.test(file) &&
          (dir !== "plugins" || /^[^/]+\/src\//.test(file)),
      )
      .map((file) => path.join(root, dir, file)),
  );

/** Page reads with `limit + 1` in the given files; a file is parsed only when it names a limit. */
const limitPlusOne = (
  files: readonly { file: string; source: string; program?: Node }[],
) => {
  const problems: string[] = [];
  for (const { file, source, program } of files) {
    if (!/limit/.test(source)) continue;
    const isLimit = (node: unknown) => {
      const value = unwrap(node) as
        | (Node & { name?: string; property?: { name?: string } })
        | undefined;
      return (
        (value?.type === "Identifier" && /limit$/i.test(value.name!)) ||
        (value?.type === "MemberExpression" &&
          /limit$/i.test(value.property?.name ?? ""))
      );
    };
    const isOne = (node: unknown) =>
      (unwrap(node) as Node | undefined)?.type === "Literal" &&
      (unwrap(node) as Node).value === 1;
    const visit = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(visit);
      if (!node || typeof node !== "object") return;
      const value = node as Node;
      if (
        value.type === "BinaryExpression" &&
        value.operator === "+" &&
        ((isLimit(value.left) && isOne(value.right)) ||
          (isOne(value.left) && isLimit(value.right)))
      ) {
        problems.push(
          `${relative(file)}:${lineOf(source, value.start)} reads limit + 1`,
        );
      }
      for (const [key, child] of Object.entries(value)) {
        if (key !== "start" && key !== "end") visit(child);
      }
    };
    visit(program ?? parse(file, source).program);
  }
  return problems;
};

/** Files the lint rule that bans filtering `findMany` results reports, across packages and plugins. */
const filteredFindMany = (() => {
  const lint = spawnSync(
    path.join(root, "node_modules/.bin/oxlint"),
    ["-c", ".oxlintrc.json", "--format", "json", "packages", "plugins"],
    { cwd: root, encoding: "utf8" },
  );
  try {
    const { diagnostics } = JSON.parse(lint.stdout) as {
      diagnostics: { code: string; filename: string }[];
    };
    return diagnostics
      .filter(({ code }) => code === "hot-updater(no-filtered-find-many)")
      .map(({ filename }) => path.resolve(root, filename));
  } catch {
    return undefined;
  }
})();

/** Filtered `findMany` results, in the given files or anywhere. */
const filtered = (files?: readonly { file: string }[]) => {
  if (filteredFindMany === undefined) {
    return ["the no-filtered-find-many lint rule did not run"];
  }
  const only = files && new Set(files.map(({ file }) => file));
  return filteredFindMany
    .filter((file) => only === undefined || only.has(file))
    .map((file) => `${relative(file)} filters findMany results`);
};

/** S7: no over-fetching in the row's code. */
const overFetchIn = (graph: ReturnType<typeof graphOf>) => [
  ...limitPlusOne(graph.files),
  ...filtered(graph.files),
];

/**
 * Zero over-fetching on request paths: no page read with `limit + 1` in the
 * server, the console, or any plugin, and no filtered `findMany` results.
 */
const overFetch = () => [
  ...limitPlusOne(
    requestPathFiles().map((file) => ({
      file,
      source: readFileSync(file, "utf8"),
    })),
  ),
  ...filtered(),
];

/**
 * Each layer as a whole passes S1: every file on its own, with its direct
 * imports, whether or not a row measures it.
 */
const layerBoundaries = (names: ReadonlySet<string>) =>
  layers.flatMap(({ name, files: globs }) => {
    const files = globs.flatMap((glob) => {
      const dir = path.join(root, glob.replace(/\/\*\*$/, ""));
      return (readdirSync(dir, { recursive: true }) as string[])
        .filter(
          (file) =>
            file.endsWith(".ts") && !/\.(spec|test-d)\.ts$|\.d\.ts$/.test(file),
        )
        .map((file) => path.join(dir, file));
    });
    const parsed = files.map((file) => parse(file, readFileSync(file, "utf8")));
    const external = parsed.flatMap(({ file, imports }) =>
      imports.flatMap((specifier) => {
        if (!specifier.startsWith(".")) {
          return isDomainPackage(specifier) ? [{ file, specifier }] : [];
        }
        const target = resolveRelative(file, specifier);
        return target && matches(target, domainImports.files)
          ? [{ file, specifier: relative(target) }]
          : [];
      }),
    );
    return boundary({ files: parsed, external }, names).map(
      (problem) => `${name}: ${problem}`,
    );
  });

/** S3's last clause: no config option turns transactions on or off. */
const transactionOptions = (graph: ReturnType<typeof graphOf>) => {
  const found: string[] = [];
  for (const { file, source, program } of graph.files) {
    const visit = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(visit);
      if (!node || typeof node !== "object") return;
      const value = node as Node;
      if (value.type === "TSPropertySignature") {
        const key = value.key as { name?: string; value?: string };
        const name = key.name ?? key.value ?? "";
        if (/transaction/i.test(name)) {
          found.push(
            `${relative(file)}:${lineOf(source, value.start)} ${name}`,
          );
        }
      }
      for (const [key, child] of Object.entries(value)) {
        if (key !== "start" && key !== "end") visit(child);
      }
    };
    visit(program);
  }
  return found;
};

interface TestResult {
  readonly title: string;
  readonly ancestorTitles: readonly string[];
  readonly status: string;
}

/** Runs every manifest suite once and returns the JSON report's path. */
const runSuites = () => {
  const suites = rows.flatMap((row) => row.suites);
  const output = path.join(os.tmpdir(), `acceptance-${process.pid}.json`);
  const projects = [...new Set(suites.map((suite) => suite.project))];
  const files = [...new Set(suites.map((suite) => suite.file))];
  spawnSync(
    "pnpm",
    [
      "exec",
      "vitest",
      "run",
      ...projects.flatMap((project) => ["--project", project]),
      ...files,
      "--reporter=default",
      "--reporter=json",
      `--outputFile.json=${output}`,
    ],
    { cwd: root, stdio: "inherit" },
  );
  if (!existsSync(output)) throw new Error("vitest wrote no JSON report");
  return output;
};

const testResults = (() => {
  const reports = args.run ? [runSuites()] : (args.results ?? []);
  if (reports.length === 0) return undefined;
  return reports.flatMap((report) =>
    (
      JSON.parse(readFileSync(report, "utf8")) as {
        testResults: { name: string; assertionResults: TestResult[] }[];
      }
    ).testResults.map((result) => ({
      // Reports from another checkout (a CI or gate clone) hold its absolute paths.
      file: result.name,
      tests: result.assertionResults,
    })),
  );
})();

/** The tests of one manifest suite, or why they cannot count. A skip counts as a failure unless `skippable` expects it. */
const suiteTests = (
  suite: AcceptanceRow["suites"][number],
  skippable: (title: string) => boolean = () => false,
) => {
  if (!testResults) return { error: "not run" };
  const tests = testResults
    .filter(
      (result) =>
        result.file === suite.file || result.file.endsWith(`/${suite.file}`),
    )
    .flatMap((result) => result.tests)
    .filter((test) => test.ancestorTitles.includes(suite.describe));
  if (tests.length === 0) return { error: `no "${suite.describe}" tests` };
  const failed = tests.filter(
    (test) =>
      test.status !== "passed" &&
      !(test.status === "skipped" && skippable(test.title)),
  );
  if (failed.length > 0) {
    return {
      error: `${failed.length} failed or skipped in "${suite.describe}"`,
    };
  }
  return { tests };
};

/** S3: the atomicity cases pass on the row's backend. */
const atomicity = (row: AcceptanceRow, options: readonly string[]) => {
  const problems = options.map((option) => `config option ${option}`);
  const suites = row.suites.filter((suite) =>
    suite.describe.endsWith("conformance"),
  );
  if (suites.length === 0) return problems;
  for (const suite of suites) {
    // Only a backend with no cap on one write skips the over-limit case.
    const result = suiteTests(
      suite,
      (title) => title === OVER_LIMIT_CASE && !row.writeLimit,
    );
    if (result.error) {
      problems.push(result.error);
      continue;
    }
    const cases = row.writeLimit
      ? [...ATOMICITY_CASES, OVER_LIMIT_CASE]
      : ATOMICITY_CASES;
    for (const title of cases) {
      if (
        !result.tests!.some(
          (test) => test.title === title && test.status === "passed",
        )
      ) {
        problems.push(`"${title}" did not pass in "${suite.describe}"`);
      }
    }
  }
  return problems;
};

/** The read-budget list: every API any manifest read-budget suite measured. */
const readBudgetApis = (() => {
  const titles = new Set<string>();
  for (const suite of rows.flatMap((row) => row.suites)) {
    if (!suite.describe.endsWith("read budgets")) continue;
    const result = suiteTests(suite);
    for (const test of result.tests ?? []) titles.add(test.title);
  }
  return titles;
})();

/** S4: read budgets for every API on the list, and full pages under capped native pages. */
const reads = (row: AcceptanceRow) => {
  const problems: string[] = [];
  for (const suite of row.suites) {
    // A conformance suite is read here for its page-cap case; S3 judges its over-limit skip.
    const result = suiteTests(
      suite,
      (title) => title === OVER_LIMIT_CASE && !row.writeLimit,
    );
    if (result.error) {
      problems.push(result.error);
      continue;
    }
    if (suite.describe.endsWith("read budgets")) {
      const measured = new Set(result.tests!.map((test) => test.title));
      const missing = [...readBudgetApis].filter((api) => !measured.has(api));
      if (missing.length > 0) {
        problems.push(
          `${missing.length} read-budget APIs missing in "${suite.describe}"`,
        );
      }
    }
    if (
      suite.describe.endsWith("conformance") &&
      !result.tests!.some(
        (test) => test.title === PAGE_CAP_CASE && test.status === "passed",
      )
    ) {
      problems.push(`"${PAGE_CAP_CASE}" did not pass in "${suite.describe}"`);
    }
  }
  return problems;
};

/**
 * Whether evidence recorded for `verified` holds at the report's commit: the
 * same commit, or one whose only changes since are evidence files, since
 * recording the evidence is itself a commit.
 */
const verifiedAt = (verified: string) => {
  if (commit.startsWith(verified) || verified.startsWith(commit)) return true;
  try {
    const changed = execFileSync(
      "git",
      ["diff", "--name-only", verified, commit],
      { cwd: root, encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean);
    return (
      changed.length > 0 &&
      changed.every((file) => file.startsWith("plans/evidence/"))
    );
  } catch {
    return false;
  }
};

/** S5: every profile of the row passed on the final commit. */
const endToEnd = (row: AcceptanceRow, commit: string) => {
  if (row.profiles.length === 0) return [];
  const file = path.join(root, EVIDENCE);
  if (!existsSync(file)) return [`no ${EVIDENCE}`];
  const evidence = JSON.parse(readFileSync(file, "utf8")) as {
    commit: string;
    runs: Record<
      string,
      { taskId?: string; result?: string; runtimeSha?: string | null }
    >;
  };
  if (!verifiedAt(evidence.commit)) {
    return [`evidence is for ${evidence.commit}, not ${commit}`];
  }
  return row.profiles.flatMap((profile) => {
    const run = evidence.runs[profile];
    if (run?.result !== "passed" || !run.taskId) {
      return [`${profile} has not passed`];
    }
    return MANAGED_PROFILES.has(profile) && !run.runtimeSha
      ? [`${profile} names no managed runtime`]
      : [];
  });
};

const commit =
  args.commit ??
  execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
const names = await domainNames();
const report = [];
for (const row of rows) {
  const graph = graphOf(row);
  const measured = await size(graph);
  const rowComplexity = complexity(graph);
  const checks = {
    S1: boundary(graph, names),
    S2: [
      ...(measured.lines > row.budget
        ? [`${measured.lines} > ${row.budget} lines`]
        : []),
      ...measured.files
        .filter((file) => !file.formatted)
        .map((file) => `${file.file} is not oxfmt-formatted`),
    ],
    S3: atomicity(row, transactionOptions(graph)),
    S4: reads(row),
    S5: endToEnd(row, commit),
    S6: rowComplexity.over.map(
      ({ at, score }) => `${at} scores ${score} > ${MAX_COMPLEXITY}`,
    ),
    S7: overFetchIn(graph),
  };
  const failing = Object.entries(checks)
    .filter(([, problems]) => problems.length > 0)
    .map(([check]) => check);
  report.push({
    row,
    lines: measured.lines,
    files: measured.files,
    checks,
    failing,
    complexity: rowComplexity,
  });
}
const overFetchProblems = overFetch();
const layerProblems = layerBoundaries(names);

const budgetOf = (row: AcceptanceRow) =>
  row.budgetLabel ?? `≤ ${row.budget.toLocaleString("en-US")}`;
const table = [
  "| Implementation | Size (budget) | Atomicity | Profile | Assessment |",
  "| --- | --- | --- | --- | --- |",
  ...report.map(({ row, lines, failing }) =>
    [
      row.name,
      `${lines.toLocaleString("en-US")} (${budgetOf(row)})`,
      row.atomicity,
      row.profiles.length === 0
        ? "N/A"
        : row.profiles.length === 9
          ? "All nine"
          : row.profiles.join(", "),
      failing.length === 0 ? "Smooth" : failing.join(", "),
    ]
      .join(" | ")
      .replace(/^/, "| ")
      .concat(" |"),
  ),
].join("\n");

console.log(`Acceptance report at ${commit.slice(0, 9)}\n\n${table}\n`);
for (const { row, files, checks } of report) {
  const problems = Object.entries(checks).flatMap(([check, list]) =>
    list.map((problem) => `  ${check}: ${problem}`),
  );
  console.log(
    `${row.name}: ${files.map((file) => `${file.file} ${file.lines}`).join(", ")}`,
  );
  if (problems.length > 0) console.log(problems.join("\n"));
}
const listed = (problems: readonly string[], pass: string) =>
  problems.length === 0
    ? pass
    : `\n${problems.map((problem) => `  ${problem}`).join("\n")}`;
console.log(
  `\nRequest paths, zero over-fetching: ${listed(overFetchProblems, "no limit + 1, and no findMany results filtered")}`,
);
console.log(
  `Storage engine layer, zero boundary violations: ${listed(layerProblems, "no domain imports, model names, or table.name branches in any file")}`,
);
console.log(
  [
    `\nComplexity (S6, cyclomatic, per function; at most ${MAX_COMPLEXITY}):\n`,
    `| Implementation | Functions | Highest | Over ${MAX_COMPLEXITY} |`,
    "| --- | --- | --- | --- |",
    ...report.map(
      ({ row, complexity: { functions, max, over } }) =>
        `| ${row.name} | ${functions} | ${max ? `${max.score} (${max.at})` : "-"} | ${over.length} |`,
    ),
  ].join("\n"),
);
console.log(
  [
    "\nNative read multipliers (S4 budgets count logical rows):\n",
    ...report.map(({ row }) => `- ${row.name}: ${row.multiplier}`),
  ].join("\n"),
);
if (args.json) {
  writeFileSync(
    args.json,
    `${JSON.stringify(
      {
        commit,
        rows: report.map(
          ({ row, lines, files, checks, failing, complexity }) => ({
            name: row.name,
            lines,
            budget: row.budget,
            files,
            checks,
            smooth: failing.length === 0,
            complexity,
            multiplier: row.multiplier,
          }),
        ),
        overFetch: overFetchProblems,
        layers: layerProblems,
      },
      null,
      2,
    )}\n`,
  );
}
process.exitCode =
  report.every(({ failing }) => failing.length === 0) &&
  overFetchProblems.length === 0 &&
  layerProblems.length === 0
    ? 0
    : 1;
