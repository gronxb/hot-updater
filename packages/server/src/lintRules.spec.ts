import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../../..");
const oxlint = path.join(root, "node_modules/.bin/oxlint");
const dir = mkdtempSync(path.join(os.tmpdir(), "hot-updater-lint-"));

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * The lines `hot-updater/no-filtered-find-many` reports on `source` under the
 * repo's oxlint config. oxlint lints only paths under its working directory,
 * so it runs from the scratch directory.
 */
const reported = (file: string, source: string): number[] => {
  writeFileSync(path.join(dir, file), source);
  let output: string;
  try {
    output = execFileSync(
      oxlint,
      ["-c", path.join(root, ".oxlintrc.json"), "--format", "json", file],
      { cwd: dir, encoding: "utf8" },
    );
  } catch (error) {
    // oxlint exits 1 when it reports an error.
    output = (error as { stdout: string }).stdout;
  }
  const { diagnostics } = JSON.parse(output) as {
    diagnostics: {
      code: string;
      labels: { span: { line: number } }[];
    }[];
  };
  return diagnostics
    .filter(({ code }) => code === "hot-updater(no-filtered-find-many)")
    .map(({ labels }) => labels[0]!.span.line);
};

const filtered = [
  "export const a = async (db: any) =>",
  '  (await db.findMany("t", {})).rows.filter((row: any) => row.ok);',
  "export const b = async (db: any) => {",
  '  const page = await db.findMany("t", {});',
  "  return page.rows.find((row: any) => row.ok);",
  "};",
  "export const c = async (db: any) => {",
  '  const { rows } = await db.findMany("t", {});',
  "  return rows.filter(Boolean);",
  "};",
].join("\n");

describe("hot-updater/no-filtered-find-many", () => {
  it("reports findMany rows filtered in code", () => {
    expect(reported("reads.ts", filtered)).toEqual([2, 5, 9]);
  });

  it("allows rows used whole, other arrays, and tests", () => {
    expect(
      reported(
        "whole.ts",
        [
          "export const d = async (db: any) =>",
          '  (await db.findMany("t", {})).rows.map((row: any) => row.id);',
          "export const e = (items: number[]) => items.filter(Boolean);",
        ].join("\n"),
      ),
    ).toEqual([]);
    expect(reported("reads.spec.ts", filtered)).toEqual([]);
  });
});
