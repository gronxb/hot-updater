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
    "constructionErrorNarrowing.mts",
    "serverPluginEntrypoints.mts",
    "serverPluginFeatures.mts",
    "storage-v2-contract.mts",
    "storage-v2-legacy-characterization.mts",
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
  diagnostics: string | readonly string[],
  rejectedMembers: readonly string[],
];

const compileFailCases = [
  ["analytics-provider-option.mts", "TS2353", ["provider"]],
  ["analytics-provider-subpath.mts", "TS2307", []],
  ["auth-input-boundary.mts", "TS2339", ["body", "json"]],
  ["better-auth-api-key-contract.mts", "TS2353", ["apiKey"]],
  [
    "auth-result-boundary.mts",
    "TS2353",
    ["response", "headers", "cookies", "session", "rawCredentials"],
  ],
  ["handler-options-generic.mts", "TS2315", []],
  ["feature-api-omission.mts", "TS2322", ["api"]],
  ["legacy-core-routes.mts", "TS2353", ["coreRoutes"]],
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
  [
    "root-analytics-capability-error.mts",
    "TS2305",
    ["InvalidAnalyticsCapabilityError"],
  ],
  ["root-analytics-feature-kind.mts", "TS2459", ["AnalyticsFeatureKind"]],
  ["root-analytics-legacy-alias.mts", "TS2459", ["analyticsLegacyAliases"]],
  [
    "root-analytics-provider-error.mts",
    "TS2305",
    ["InvalidAnalyticsProviderError"],
  ],
  ["routes-analytics.mts", "TS2353", []],
  ["routes-event-ingestion.mts", "TS2353", []],
  ["standalone-analytics-export.mts", "TS2305", ["standaloneAnalytics"]],
  ["structural-config-feature-manifest.mts", "TS2322", []],
  ["structural-manifest-forgery.mts", "TS2739", []],
  [
    "storage-v2-invalid-context-and-inputs.mts",
    ["TS2322", "TS2741"],
    ["browser", "environment", "bindings"],
  ],
  [
    "storage-v2-invalid-missing-content-length.mts",
    "TS2345",
    ["contentLength"],
  ],
  ["storage-v2-invalid-positional.mts", "TS2554", []],
  ["storage-v2-invalid-prefix-delete.mts", "TS2353", ["prefix"]],
  [
    "storage-v2-invalid-node-body.mts",
    "TS2322",
    ["NodeReadableStream", "filePath"],
  ],
  [
    "storage-v2-invalid-ranges.mts",
    ["TS2322", "TS2353"],
    ["start", "end", "length"],
  ],
  [
    "storage-v2-invalid-token-authority.mts",
    "TS2724",
    ["StorageInvocationAuthority"],
  ],
  [
    "storage-v2-invalid-token-construction.mts",
    "TS2741",
    ["storageInvocationTokenBrand"],
  ],
  ["storage-v2-invalid-tokenless-calls.mts", "TS2554", []],
  ["storage-v2-invalid-public-invocation.mts", "TS2554", []],
  [
    "storage-v2-invalid-root-storage-error.mts",
    "TS2724",
    ["StoragePluginError"],
  ],
  [
    "storage-v2-invalid-error-and-results.mts",
    "TS2345",
    ["network", "metadata", "storageUri"],
  ],
] satisfies readonly CompileFailCase[];

describe("server plugin compile-fail fixtures", () => {
  it.each(compileFailCases)(
    "rejects %s at the intended boundary",
    (file, diagnostics, rejectedMembers) => {
      // Given / When
      const result = compileFixture(failDirectory, file);
      const output = `${result.stdout}${result.stderr}`;

      // Then
      expect(result.status).not.toBe(0);
      expect(output).toContain(file);
      for (const diagnostic of typeof diagnostics === "string"
        ? [diagnostics]
        : diagnostics) {
        expect(output).toContain(diagnostic);
      }
      for (const member of rejectedMembers) {
        expect(output).toContain(member);
      }
    },
  );
});
