import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

export type ProviderAnalyticsBoundaryViolation = {
  readonly column: number;
  readonly file: string;
  readonly line: number;
  readonly rule: string;
};

export type ProviderAnalyticsBoundaryOptions = {
  readonly includeTests?: boolean;
  readonly roots: readonly string[];
};

type BoundaryRule = {
  readonly name: string;
  readonly pattern: RegExp;
};

const rules: readonly BoundaryRule[] = [
  {
    name: "Analytics package import",
    pattern: /@hot-updater\/analytics/g,
  },
  {
    name: "Analytics module import",
    pattern:
      /(?:from\s*|import\s*\()\s*["'](?!@hot-updater\/analytics(?:["'/]))[^"']*analytics[^"']*["']/gi,
  },
  {
    name: "Analytics capability",
    pattern:
      /(?:hot-updater\.analytics\.provider|analyticsProviderCapability)/g,
  },
  {
    name: "Analytics contract identifier",
    pattern:
      /\b(?:Analytics(?:Provider|Persistence|Migration|Schema|Queries)|analytics(?:Provider|Persistence|Migration|Schema|Queries))\b/g,
  },
  {
    name: "Analytics schema marker",
    pattern: /schema\.analytics/g,
  },
  {
    name: "Analytics physical table",
    pattern: /\bbundle_events\b/g,
  },
  {
    name: "Analytics event literal",
    pattern: /["'`](?:UPDATE_APPLIED|RECOVERED|UNCHANGED)["'`]/g,
  },
];

const sourceExtensions = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".json",
  ".jsx",
  ".mjs",
  ".mts",
  ".sql",
  ".ts",
  ".tsx",
]);

const ignoredDirectories = new Set([
  ".git",
  ".nx",
  "coverage",
  "dist",
  "node_modules",
]);

const isIgnoredDirectory = (name: string): boolean =>
  ignoredDirectories.has(name) || name.startsWith("runtime-acceptance-");

const isTestFile = (file: string): boolean =>
  /(?:^|\/)(?:__tests__|test|tests)(?:\/|$)/.test(file) ||
  /\.(?:spec|test)\.[^.]+$/.test(file) ||
  /(?:^|\/)test-utils(?:\/|$)/.test(file) ||
  /(?:^|\/)vitest\.[^/]+$/.test(file);

const sourceFiles = async (
  root: string,
  includeTests: boolean,
): Promise<readonly string[]> => {
  const files: string[] = [];

  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!isIgnoredDirectory(entry.name)) {
          await visit(path.join(directory, entry.name));
        }
        continue;
      }
      if (!entry.isFile()) continue;

      const file = path.join(directory, entry.name);
      if (
        sourceExtensions.has(path.extname(entry.name)) &&
        (includeTests || !isTestFile(file))
      ) {
        files.push(file);
      }
    }
  };

  await visit(root);
  return files.toSorted();
};

const locationAt = (
  contents: string,
  offset: number,
): { readonly column: number; readonly line: number } => {
  const prefix = contents.slice(0, offset);
  const lineStart = prefix.lastIndexOf("\n") + 1;
  return {
    column: offset - lineStart + 1,
    line: prefix.split("\n").length,
  };
};

export const findProviderAnalyticsBoundaryViolations = async ({
  includeTests = false,
  roots,
}: ProviderAnalyticsBoundaryOptions): Promise<
  readonly ProviderAnalyticsBoundaryViolation[]
> => {
  const violations: ProviderAnalyticsBoundaryViolation[] = [];

  for (const root of roots) {
    const resolvedRoot = path.resolve(root);
    for (const file of await sourceFiles(resolvedRoot, includeTests)) {
      if (
        path.relative(resolvedRoot, file).toLowerCase().includes("analytics")
      ) {
        violations.push({
          column: 1,
          file,
          line: 1,
          rule: "Analytics module path",
        });
      }
      const contents = await readFile(file, "utf8");
      for (const rule of rules) {
        for (const match of contents.matchAll(rule.pattern)) {
          const location = locationAt(contents, match.index);
          violations.push({ file, rule: rule.name, ...location });
        }
      }
    }
  }

  return violations;
};

export const assertProviderAnalyticsBoundary = async (
  options: ProviderAnalyticsBoundaryOptions,
): Promise<void> => {
  const violations = await findProviderAnalyticsBoundaryViolations(options);
  if (violations.length === 0) return;

  throw new Error(
    [
      "Ordinary database providers must not depend on the Analytics contract:",
      ...violations.map(
        ({ column, file, line, rule }) => `${file}:${line}:${column} ${rule}`,
      ),
    ].join("\n"),
  );
};
