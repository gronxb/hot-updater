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
 * The lines `hot-updater/<rule>` reports on `source` under the repo's oxlint
 * config. oxlint lints only paths under its working directory, so it runs
 * from the scratch directory.
 */
const reportedBy = (rule: string, file: string, source: string): number[] => {
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
    .filter(({ code }) => code === `hot-updater(${rule})`)
    .map(({ labels }) => labels[0]!.span.line);
};

const reported = (file: string, source: string): number[] =>
  reportedBy("no-filtered-find-many", file, source);

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

describe("hot-updater/id-naming", () => {
  const idNaming = (file: string, lines: readonly string[]) =>
    reportedBy("id-naming", file, lines.join("\n"));

  it("reports a release ID shown through an artifact's bundleId", () => {
    // The bug that showed a release's label with its artifact's ID.
    expect(
      idNaming("ServedNow.tsx", [
        "declare const ReleaseIdDisplay: (props: any) => null;",
        "export const Row = ({ release }: { release: any }) => (",
        "  <ReleaseIdDisplay releaseId={release.bundleId} label={release.label} />",
        ");",
      ]),
    ).toEqual([3]);
  });

  it("reports each binding that crosses the two kinds", () => {
    expect(
      idNaming("bindings.ts", [
        "declare const release: { id: string; bundleId: string };",
        "declare const bundle: { id: string };",
        "declare const row: { releaseId: string | null; bundleId: string };",
        "export const a = { bundleId: release.id };",
        "export const b = { releaseId: bundle.id };",
        "export const c = { toBundleId: row.releaseId ?? row.bundleId };",
        "const releaseId = row.bundleId;",
        "let bundleId = row.bundleId;",
        "bundleId = release.id;",
        "export const { bundleId: activeReleaseId } = row;",
        "export const d = (releaseIds = [row.bundleId]) => releaseIds;",
        "export const e = (releaseId = row.bundleId) => releaseId;",
        "export class F { bundleId = row.releaseId; }",
        "export { releaseId, bundleId };",
      ]),
    ).toEqual([4, 5, 6, 7, 9, 10, 12, 13]);
  });

  it("allows matching kinds, neutral names, calls, and a reasoned disable", () => {
    expect(
      idNaming("allowed.tsx", [
        "declare const release: { id: string; bundleId: string };",
        "declare const row: { releaseId: string | null; bundleId: string };",
        "declare const getBundleId: () => string;",
        "declare const ReleaseIdDisplay: (props: any) => null;",
        "export const a = { releaseId: release.id, bundleId: release.bundleId };",
        "export const b = { id: row.releaseId ?? row.bundleId };",
        "export const c = { releaseId: getBundleId() };",
        "export const d = <ReleaseIdDisplay releaseId={release.id} />;",
        "export const e = {",
        "  // oxlint-disable-next-line hot-updater/id-naming -- display fallback",
        "  releaseId: row.releaseId ?? row.bundleId,",
        "};",
      ]),
    ).toEqual([]);
  });
});
