/**
 * The acceptance report (PRD "Final acceptance"): measures every manifest row
 * against S1–S5 and redraws the implementation table. A row that fails a
 * check shows that check instead of Smooth, and the script exits 1.
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
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
      if (!specifier.startsWith(".")) {
        external.push({ file, specifier });
        continue;
      }
      const target = resolveRelative(file, specifier);
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
      if (column.name.startsWith("_")) continue;
      if (!genericFieldNames.includes(column.name)) names.add(column.name);
    }
  }
  return names;
};

const isTableName = (node: unknown): boolean => {
  const value = node as Node | undefined;
  if (value?.type !== "MemberExpression" || value.computed) return false;
  if ((value.property as Node & { name?: string }).name !== "name")
    return false;
  const object = value.object as Node & { name?: string; computed?: boolean };
  return (
    (object.type === "Identifier" && object.name === "table") ||
    (object.type === "MemberExpression" &&
      !object.computed &&
      (object.property as { name?: string }).name === "table")
  );
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
  const strings = (node: unknown) => {
    const value = unwrap(node);
    const list =
      value?.type === "NewExpression" &&
      (value.callee as { name?: string }).name === "Set"
        ? unwrap((value.arguments as unknown[])[0])
        : value;
    return (
      list?.type === "ArrayExpression" &&
      (list.elements as unknown[]).every(isStringLiteral)
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
      domainImports.packages.some((pattern) =>
        path.matchesGlob(specifier, pattern),
      )
    ) {
      violations.push(`${relative(file)} imports ${specifier}`);
    }
  }
  for (const { file, source, program } of graph.files) {
    const at = (node: Node) =>
      `${relative(file)}:${lineOf(source, node.start)}`;
    const bindings = literalBindings(program);
    /** A string, or a name bound to one: comparing table.name with it singles a table out. */
    const named = (node: unknown) => {
      const value = unwrap(node) as (Node & { name?: string }) | undefined;
      return (
        isStringLiteral(value) ||
        (value?.type === "Identifier" && bindings.get(value.name!) === "string")
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
            ((isTableName(value.left) && named(value.right)) ||
              (isTableName(value.right) && named(value.left)))
          ) {
            violations.push(`${at(value)} branches on table.name`);
          }
          break;
        case "SwitchStatement":
          if (
            isTableName(value.discriminant) &&
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
          const list = unwrap(callee.object);
          if (
            callee.type === "MemberExpression" &&
            ["has", "includes"].includes(callee.property?.name ?? "") &&
            isTableName((value.arguments as unknown[])[0]) &&
            ((list?.type === "Identifier" &&
              bindings.get((list as { name?: string }).name!) === "strings") ||
              list?.type === "ArrayExpression")
          ) {
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

/** The tests of one manifest suite, or why they cannot count. */
const suiteTests = (suite: AcceptanceRow["suites"][number]) => {
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
    (test) => test.status !== "passed" && test.status !== "skipped",
  );
  if (failed.length > 0) {
    return { error: `${failed.length} failed in "${suite.describe}"` };
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
    const result = suiteTests(suite);
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

/** S4: read budgets and full pages under capped native pages. */
const reads = (row: AcceptanceRow) => {
  const problems: string[] = [];
  for (const suite of row.suites) {
    const result = suiteTests(suite);
    if (result.error) {
      problems.push(result.error);
      continue;
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
  if (
    !commit.startsWith(evidence.commit) &&
    !evidence.commit.startsWith(commit)
  ) {
    return [`evidence is for ${evidence.commit}, not ${commit}`];
  }
  return row.profiles.flatMap((profile) => {
    const run = evidence.runs[profile];
    return run?.result === "passed" && run.taskId
      ? []
      : [`${profile} has not passed`];
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
  });
}

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
if (args.json) {
  writeFileSync(
    args.json,
    `${JSON.stringify(
      {
        commit,
        rows: report.map(({ row, lines, files, checks, failing }) => ({
          name: row.name,
          lines,
          budget: row.budget,
          files,
          checks,
          smooth: failing.length === 0,
        })),
      },
      null,
      2,
    )}\n`,
  );
}
process.exitCode = report.every(({ failing }) => failing.length === 0) ? 0 : 1;
