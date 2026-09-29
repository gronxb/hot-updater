import fs from "fs/promises";
import path from "path";

import { p } from "@hot-updater/cli-tools";
import fg from "fast-glob";

import { ui } from "../../utils/cli-ui";
import { formatUnifiedDiff } from "./unifiedDiff";

export interface CodemodIssue {
  readonly line: number;
  readonly column: number;
  readonly message: string;
}

export interface CodemodResult {
  /** The rewritten source; the input itself when nothing changed or an issue was found. */
  readonly text: string;
  /** Why the file was left unchanged: every call in a file is rewritten, or none is. */
  readonly issues: readonly CodemodIssue[];
}

export interface Codemod {
  readonly name: string;
  /** Only files that contain this text are parsed. */
  readonly marker: string;
  readonly transform: (source: string, filename: string) => CodemodResult;
}

export interface CodemodOptions {
  /** Prints the diff of each file instead of writing it. */
  readonly dryRun?: boolean;
  readonly cwd?: string;
}

const SOURCE_FILES = "**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}";
const IGNORED_DIRECTORIES = ["**/node_modules/**", "**/dist/**", "**/build/**"];

/** Source files under each path: a file, a directory, or a glob pattern. */
const resolveFiles = async (
  targets: readonly string[],
  cwd: string,
): Promise<{ readonly files: string[]; readonly missing: string[] }> => {
  const files = new Set<string>();
  const missing: string[] = [];
  for (const target of targets.length > 0 ? targets : ["."]) {
    const absolute = path.resolve(cwd, target);
    const stat = await fs.stat(absolute).catch(() => null);
    const matches = stat?.isFile()
      ? [absolute]
      : stat?.isDirectory()
        ? await fg(SOURCE_FILES, {
            absolute: true,
            cwd: absolute,
            ignore: IGNORED_DIRECTORIES,
          })
        : fg.isDynamicPattern(target)
          ? await fg(target, {
              absolute: true,
              cwd,
              ignore: ["**/node_modules/**"],
            })
          : null;
    if (matches === null) {
      missing.push(target);
      continue;
    }
    for (const file of matches) files.add(path.normalize(file));
  }
  return { files: [...files].sort(), missing };
};

const colorDiffLine = (line: string): string => {
  if (line.startsWith("---") || line.startsWith("+++")) return ui.title(line);
  if (line.startsWith("@@")) return ui.platform(line);
  if (line.startsWith("-")) return ui.danger(line);
  if (line.startsWith("+")) return ui.success(line);
  return line;
};

const plural = (count: number, noun: string) =>
  `${count} ${noun}${count === 1 ? "" : "s"}`;

/**
 * Runs a codemod over files, directories, or globs (the current directory by
 * default). Files it cannot rewrite safely are reported and left unchanged,
 * and the process then exits with code 1.
 */
export const runCodemod = async (
  codemod: Codemod,
  targets: readonly string[],
  options: CodemodOptions = {},
): Promise<void> => {
  const cwd = options.cwd ?? process.cwd();
  const { files, missing } = await resolveFiles(targets, cwd);
  if (missing.length > 0) {
    p.log.error(`Path not found: ${missing.join(", ")}`);
    process.exit(1);
  }

  const changed: string[] = [];
  let reported = 0;
  for (const file of files) {
    const source = await fs.readFile(file, "utf-8");
    if (!source.includes(codemod.marker)) continue;
    const displayPath = path.relative(cwd, file).split(path.sep).join("/");
    const result = codemod.transform(source, file);
    if (result.issues.length > 0) {
      reported += 1;
      for (const issue of result.issues) {
        p.log.warn(
          `${ui.path(`${displayPath}:${issue.line}:${issue.column}`)} ${issue.message}`,
        );
      }
      continue;
    }
    if (result.text === source) continue;
    changed.push(displayPath);
    if (options.dryRun) {
      console.log(
        formatUnifiedDiff(displayPath, source, result.text)
          .split("\n")
          .map(colorDiffLine)
          .join("\n"),
      );
    } else {
      await fs.writeFile(file, result.text, "utf-8");
    }
  }

  if (options.dryRun && changed.length > 0) {
    p.log.info(
      `${codemod.name}: ${plural(changed.length, "file")} would change; run without --dry-run to write them.`,
    );
  } else if (changed.length > 0) {
    p.log.success(
      ui.block(
        `${codemod.name}: updated ${plural(changed.length, "file")}`,
        changed.map((file) => `  ${ui.path(file)}`),
      ),
    );
  } else if (reported === 0) {
    p.log.info(`${codemod.name}: no files need changes.`);
  }
  if (reported > 0) {
    p.log.error(
      `${codemod.name}: ${plural(reported, "file")} left unchanged; migrate the reported calls by hand.`,
    );
    process.exit(1);
  }
};
