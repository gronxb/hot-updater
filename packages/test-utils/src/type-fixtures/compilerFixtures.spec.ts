import { spawnSync } from "node:child_process";
import { copyFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createPackedConsumer,
  type PackedConsumer,
  resolveServerPluginPackageDirectories,
} from "./packedPackageTestUtils";

const workspaceRoot = path.resolve(import.meta.dirname, "../../../..");
const fixtureRoot = path.resolve(import.meta.dirname, "../../type-fixtures");
const typescriptCli = path.join(
  workspaceRoot,
  "node_modules",
  "typescript",
  "bin",
  "tsc",
);

let consumer: PackedConsumer;
let failDirectory: string;
let passDirectory: string;

const stageFixtureDirectory = async (kind: "fail" | "pass") => {
  const sourceDirectory = path.join(fixtureRoot, kind);
  const targetDirectory = path.join(consumer.directory, "type-fixtures", kind);
  await mkdir(targetDirectory, { recursive: true });
  for (const file of await readdir(sourceDirectory)) {
    if (file.endsWith(".fixture")) {
      await copyFile(
        path.join(sourceDirectory, file),
        path.join(targetDirectory, file.slice(0, -".fixture".length)),
      );
    }
  }
  return targetDirectory;
};

const compileFixture = (directory: string, file: string) =>
  spawnSync(
    process.execPath,
    [
      typescriptCli,
      "--exactOptionalPropertyTypes",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--noEmit",
      "--noUncheckedIndexedAccess",
      "--skipLibCheck",
      "false",
      "--strict",
      "--target",
      "ES2022",
      "--verbatimModuleSyntax",
      path.join(directory, file),
    ],
    {
      cwd: consumer.directory,
      encoding: "utf8",
    },
  );

beforeAll(async () => {
  consumer = await createPackedConsumer(
    resolveServerPluginPackageDirectories(workspaceRoot),
  );
  [failDirectory, passDirectory] = await Promise.all([
    stageFixtureDirectory("fail"),
    stageFixtureDirectory("pass"),
  ]);
}, 60_000);

afterAll(async () => {
  await consumer.dispose();
});

describe("server plugin compile-pass fixtures", () => {
  it.each([
    "composer-conflicts.mts",
    "serverPluginEntrypoints.mts",
    "serverPluginFeatures.mts",
    "typeAssertions.mts",
  ])("accepts %s through packed public declarations", (file) => {
    // Given / When
    const result = compileFixture(passDirectory, file);
    const output = `${result.stdout}${result.stderr}`;

    // Then
    expect(result.status, output).toBe(0);
  });
});

type CompileFailCase = readonly [
  file: string,
  diagnostic: string,
  rejectedMembers: readonly string[],
];

const compileFailCases = [
  ["auth-input-boundary.mts", "TS2339", ["body", "json"]],
  [
    "auth-result-boundary.mts",
    "TS2353",
    ["response", "headers", "cookies", "session", "rawCredentials"],
  ],
  ["handler-options-generic.mts", "TS2315", []],
  ["invalid-internal-alias.mts", "TS2344", ["legacyMissing", "missing"]],
  ["omitted-analytics-access.mts", "TS2339", ["analytics"]],
  [
    "readonly-projections.mts",
    "TS2540",
    ["subject", "id", "status", "analytics", "features"],
  ],
  [
    "root-manifest-authoring.mts",
    "TS2305",
    ["defineFirstPartyFeatureManifest"],
  ],
  ["routes-analytics.mts", "TS2353", []],
  ["routes-event-ingestion.mts", "TS2353", []],
  ["structural-manifest-forgery.mts", "TS2741", []],
  ["warn-alias-without-narrowing.mts", "TS2339", ["getBundleEventSummary"]],
  ["widened-policy-as-available.mts", "TS2322", []],
] satisfies readonly CompileFailCase[];

describe("server plugin compile-fail fixtures", () => {
  it.each(compileFailCases)(
    "rejects %s at the intended boundary",
    (file, diagnostic, rejectedMembers) => {
      // Given / When
      const result = compileFixture(failDirectory, file);
      const output = `${result.stdout}${result.stderr}`;

      // Then
      expect(result.status).not.toBe(0);
      expect(output).toContain(file);
      expect(output).toContain(diagnostic);
      for (const member of rejectedMembers) {
        expect(output).toContain(member);
      }
    },
  );
});
