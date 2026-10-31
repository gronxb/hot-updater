import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { parseSync, Visitor } from "oxc-parser";
import { describe, expect, it } from "vitest";

const SOURCE_ROOTS = [
  path.resolve(__dirname),
  path.resolve(__dirname, "../../hot-updater/src"),
];

/**
 * The files whose `console` calls print something other than the CLI's own
 * human output, so they stay as they are, each with the reason.
 */
const NOT_HUMAN_OUTPUT: Readonly<Record<string, string>> = {
  "banner.ts": "a box boxen lays out, which is no wider than its text",
  "log.ts": "`log` fits what it prints with fitText",
  "commands/keys.ts": "a public key and native snippets to paste, unbroken",
  "commands/generate-standalone-sql.ts": "SQL to run, and a stack with DEBUG",
  "commands/generate.ts": "a stack with DEBUG",
  "commands/migrate.ts": "a stack with DEBUG",
  "commands/console.ts": "the Console server's raw failure",
  "commands/fingerprint.ts": "the bare hash on stdout, for scripts",
  "commands/utils/load-hot-updater.ts": "an import's raw failure with DEBUG",
  "utils/reportUnexpectedError.ts": "a stack with DEBUG",
  "commands/buildNative.ts":
    "what execa read from a failed tool, as it wrote it",
};

const walk = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return walk(file);
    return /\.tsx?$/u.test(entry.name) && !/\.spec\.tsx?$/u.test(entry.name)
      ? [file]
      : [];
  });

/** The part of an ESTree node this spec reads. */
interface SourceNode {
  readonly type: string;
  readonly start: number;
  readonly end: number;
  readonly callee?: SourceNode;
  readonly expression?: SourceNode;
  readonly consequent?: SourceNode;
  readonly alternate?: SourceNode;
  readonly arguments?: readonly SourceNode[];
}

/** The console calls in `file` that print what nothing fitted. */
const unfittedConsoleCalls = (file: string): string[] => {
  const source = readFileSync(file, "utf8");
  const text = ({ start, end }: SourceNode) => source.slice(start, end);
  // JSON for `--json`, or text `fitText` fitted.
  const isFittedOrJson = (node: SourceNode): boolean => {
    if (node.type === "ParenthesizedExpression") {
      return isFittedOrJson(node.expression!);
    }
    if (node.type === "ConditionalExpression") {
      return (
        isFittedOrJson(node.consequent!) && isFittedOrJson(node.alternate!)
      );
    }
    return (
      node.type === "CallExpression" &&
      ["fitText", "JSON.stringify"].includes(text(node.callee!))
    );
  };
  const found: string[] = [];
  new Visitor({
    CallExpression(call) {
      const node = call as unknown as SourceNode;
      if (
        /^console\.(log|info|warn|error)$/u.test(text(node.callee!)) &&
        !node.arguments!.every(isFittedOrJson)
      ) {
        found.push(`${file} ${text(node).slice(0, 60)}`);
      }
    },
  }).visit(parseSync(file, source).program);
  return found;
};

describe("the CLI's human output", () => {
  const files = SOURCE_ROOTS.flatMap((root) =>
    walk(root).map((file) => ({
      file,
      relative: path.relative(root, file).split(path.sep).join("/"),
    })),
  );

  it("reads the CLI's sources", () => {
    expect(files.map(({ relative }) => relative)).toEqual(
      expect.arrayContaining(["commands/doctor.ts", "prompts.ts"]),
    );
  });

  it("catches a console call nothing fitted", () => {
    const file = path.join(SOURCE_ROOTS[1]!, "commands/fingerprint.ts");
    expect(unfittedConsoleCalls(file)).toEqual([`${file} console.log(hash)`]);
  });

  it("prints through p, or fits what it prints another way", () => {
    expect(
      files
        .filter(({ relative }) => !(relative in NOT_HUMAN_OUTPUT))
        .flatMap(({ file }) => unfittedConsoleCalls(file)),
    ).toEqual([]);
  });

  it("names only exceptions that still print to the console", () => {
    expect(
      files
        .filter(({ relative }) => relative in NOT_HUMAN_OUTPUT)
        .filter(({ file }) => unfittedConsoleCalls(file).length === 0)
        .map(({ relative }) => relative),
    ).toEqual([]);
  });

  it("reaches clack only through p and the step line, which fit their lines", () => {
    expect(
      files
        .filter(({ file }) =>
          readFileSync(file, "utf8").includes('"@clack/prompts"'),
        )
        .map(({ relative }) => relative)
        .sort(),
    ).toEqual(["prompts.ts", "step.ts"]);
  });
});
