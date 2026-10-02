import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readDocumentation } from "./docs-content";

const docsRoot = fileURLToPath(new URL("..", import.meta.url));
const repositoryRoot = path.resolve(docsRoot, "..");

/**
 * A code block titled as a whole config file is a file readers copy as it is.
 * A block that shows part of one says so in its title, such as
 * `hot-updater.config.ts (excerpt)`.
 */
const WHOLE_CONFIG_FILE = /^(hot-updater|console)\.config\.ts$/;

/** The code a reader copies: no removed diff lines and no notation comments. */
const appliedCode = (code: string) =>
  code
    .split("\n")
    .filter((line) => !line.includes("[!code --]"))
    .map((line) => line.replace(/\s*\/\/ \[!code [^\]]+\]/, ""))
    .join("\n");

const examples = readDocumentation(
  path.join(docsRoot, "content/docs"),
).files.flatMap((file) =>
  file.type === "page"
    ? file.data.codeBlocks
        .filter(
          (block) =>
            (block.lang === "ts" || block.lang === "typescript") &&
            WHOLE_CONFIG_FILE.test(block.title),
        )
        .map((block) => ({
          name: `${file.path}:${block.line}`,
          fileName: `${file.path.replace(/[^\w.-]+/g, "_")}-${block.line}.ts`,
          code: appliedCode(block.code),
        }))
    : [],
);

/** The workspace's packages by name, as a reader's project installs them. */
const workspacePackages = new Map(
  ["packages", "plugins"].flatMap((group) =>
    readdirSync(path.join(repositoryRoot, group), { withFileTypes: true })
      .map((entry) => path.join(repositoryRoot, group, entry.name))
      .filter((directory) => existsSync(path.join(directory, "package.json")))
      .map((directory) => {
        const { name } = JSON.parse(
          readFileSync(path.join(directory, "package.json"), "utf8"),
        ) as { name: string };
        return [name, directory] as const;
      }),
  ),
);

/** The packages `code` imports, without subpaths or Node.js built-ins. */
const importedPackages = (code: string) =>
  [...code.matchAll(/\bfrom\s+["']([^"'.][^"']*)["']/g)]
    .map(([, specifier]) =>
      specifier!
        .split("/")
        .slice(0, specifier!.startsWith("@") ? 2 : 1)
        .join("/"),
    )
    .filter((name) => !name.startsWith("node:"));

/**
 * Where the reader's project finds a package: the workspace package itself,
 * which needs it built, or a dependency such as `firebase-admin` that a
 * workspace package installs.
 */
const packageDirectory = (name: string) =>
  workspacePackages.get(name) ??
  [...workspacePackages.values()]
    .map((directory) => path.join(directory, "node_modules", name))
    .find((directory) => existsSync(directory));

let project = "";
const errorsByExample = new Map<string, string[]>();

beforeAll(() => {
  project = mkdtempSync(path.join(tmpdir(), "hot-updater-config-examples-"));
  for (const name of new Set(
    examples.flatMap(({ code }) => importedPackages(code)),
  )) {
    const directory = packageDirectory(name);
    // The compiler reports a package it cannot find.
    if (directory === undefined) continue;
    const link = path.join(project, "node_modules", name);
    mkdirSync(path.dirname(link), { recursive: true });
    symlinkSync(directory, link, "junction");
  }
  for (const { fileName, code } of examples) {
    writeFileSync(path.join(project, fileName), code);
  }
  writeFileSync(
    path.join(project, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "bundler",
        moduleDetection: "force",
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        types: ["node"],
        typeRoots: [path.join(docsRoot, "node_modules/@types")],
      },
      include: ["*.ts"],
    }),
  );

  let output = "";
  try {
    execFileSync(
      process.execPath,
      [
        // The compiler `test:type` runs.
        path.join(docsRoot, "node_modules/@typescript/native/bin/tsc"),
        "--project",
        project,
        "--pretty",
        "false",
      ],
      { cwd: project, encoding: "utf8" },
    );
  } catch (error) {
    output = String((error as { stdout?: string }).stdout || error);
  }

  for (const { name } of examples) errorsByExample.set(name, []);
  const unattributed: string[] = [];
  let current: string[] = unattributed;
  for (const line of output.split("\n").filter(Boolean)) {
    const error = /^(.+?)\((\d+),\d+\): error (TS\d+: .*)$/.exec(line);
    if (error === null) {
      if (line.startsWith(" ") && current.length > 0) {
        current[current.length - 1] += `\n${line}`;
      } else {
        unattributed.push(line);
      }
      continue;
    }
    const example = examples.find(
      ({ fileName }) => fileName === path.basename(error[1]!),
    );
    current = example ? errorsByExample.get(example.name)! : unattributed;
    current.push(`line ${error[2]} of the block: ${error[3]}`);
  }
  if (unattributed.length > 0) {
    throw new Error(`tsc failed:\n${unattributed.join("\n")}`);
  }
}, 180_000);

afterAll(() => {
  if (project) rmSync(project, { recursive: true, force: true });
});

describe("whole config files in the docs", () => {
  it("finds the config examples", () => {
    expect(examples).not.toHaveLength(0);
  });

  it.each(examples.map(({ name }) => name))("%s compiles", (name) => {
    expect(errorsByExample.get(name)?.join("\n")).toBe("");
  });
});
