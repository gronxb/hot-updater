import { execFile } from "node:child_process";
import { access, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createPackedConsumer,
  type PackedConsumer,
  resolveStorageV2PackageDirectories,
  runNode,
  runNodeWithConditions,
} from "./packedPackageTestUtils";
import {
  conditionalRuntimeEntries,
  dualRuntimeEntries,
  esmRuntimeEntries,
  legacyRuntimeEntries,
  storageCommonJsTypeFixture,
  storageTypeFixture,
  unsupportedDefaultEntries,
} from "./storageV2PackedMatrix";

const workspaceRoot = path.resolve(import.meta.dirname, "../../../..");
const packageDirectories = resolveStorageV2PackageDirectories(workspaceRoot);
const execFileAsync = promisify(execFile);

let consumer: PackedConsumer;

const readProperty = (target: unknown, key: string): unknown => {
  if (typeof target !== "object" || target === null) {
    throw new TypeError(`Cannot read ${key} from a non-object value.`);
  }
  return Reflect.get(target, key);
};

const resolveExportTarget = (
  target: unknown,
  conditions: readonly string[],
): string => {
  if (typeof target === "string") {
    return target;
  }
  if (typeof target !== "object" || target === null) {
    throw new TypeError("Package export target must be a string or object.");
  }
  for (const [condition, nested] of Object.entries(target)) {
    if (condition === "default" || conditions.includes(condition)) {
      return resolveExportTarget(nested, conditions);
    }
  }
  throw new TypeError(`No export matched conditions: ${conditions.join(",")}`);
};

beforeAll(async () => {
  consumer = await createPackedConsumer(packageDirectories, {
    "@types/node": "20.19.43",
  });
}, 120_000);

afterAll(async () => {
  await consumer?.dispose();
});

describe("packed Storage v2 package consumers", () => {
  it("installs tarballs without workspace or source aliases", async () => {
    for (const [name, installedDirectory] of consumer.packageDirectories) {
      const resolvedDirectory = await realpath(installedDirectory);
      expect(resolvedDirectory.startsWith(workspaceRoot)).toBe(false);
      expect(
        await readFile(path.join(installedDirectory, "package.json"), "utf8"),
        name,
      ).not.toContain("workspace:");
    }
  });

  it.each([...dualRuntimeEntries, ...legacyRuntimeEntries])(
    "loads %s from its packed ESM artifact",
    async (specifier, exportName) => {
      await runNode(
        consumer.directory,
        `const api = await import(${JSON.stringify(specifier)});
if (typeof api[${JSON.stringify(exportName)}] !== "function") process.exit(1);`,
        true,
      );
    },
  );

  it.each([...dualRuntimeEntries, ...legacyRuntimeEntries])(
    "loads %s from its packed CommonJS artifact",
    async (specifier, exportName) => {
      await runNode(
        consumer.directory,
        `const api = require(${JSON.stringify(specifier)});
if (typeof api[${JSON.stringify(exportName)}] !== "function") process.exit(1);`,
        false,
      );
    },
  );

  it.each(esmRuntimeEntries)(
    "loads ESM-only %s from its packed artifact",
    async (specifier, exportName) => {
      await runNode(
        consumer.directory,
        `const api = await import(${JSON.stringify(specifier)});
if (typeof api[${JSON.stringify(exportName)}] !== "function") process.exit(1);`,
        true,
      );
    },
  );

  it.each(conditionalRuntimeEntries)(
    "resolves %s under the %s condition",
    async (specifier, condition, exportName) => {
      await runNodeWithConditions(
        consumer.directory,
        `const api = await import(${JSON.stringify(specifier)});
if (typeof api[${JSON.stringify(exportName)}] !== "function") process.exit(1);`,
        [condition],
      );
    },
  );

  it("pairs Supabase worker and edge conditions to the same packed Web artifacts", async () => {
    const packageDirectory = consumer.packageDirectories.get(
      "@hot-updater/supabase",
    );
    if (packageDirectory === undefined) {
      throw new TypeError("Missing installed @hot-updater/supabase package.");
    }
    const parsed: unknown = JSON.parse(
      await readFile(path.join(packageDirectory, "package.json"), "utf8"),
    );
    const storageExport = readProperty(
      readProperty(parsed, "exports"),
      "./storage",
    );

    expect(resolveExportTarget(storageExport, ["worker", "import"])).toBe(
      resolveExportTarget(storageExport, ["edge", "import"]),
    );
    expect(resolveExportTarget(storageExport, ["worker", "require"])).toBe(
      resolveExportTarget(storageExport, ["edge", "require"]),
    );
    for (const condition of ["worker", "edge"]) {
      await execFileAsync(
        process.execPath,
        [
          `--conditions=${condition}`,
          "--eval",
          'const api = require("@hot-updater/supabase/storage"); if (typeof api.supabaseStorage !== "function") process.exit(1);',
        ],
        { cwd: consumer.directory },
      );
    }
  });

  it("loads every explicit target context helper from packed artifacts", async () => {
    await runNode(
      consumer.directory,
      `const node = await import("@hot-updater/plugin-core/storage/node");
const lambda = await import("@hot-updater/aws/storage/lambda");
const worker = await import("@hot-updater/cloudflare/storage/worker");
const functions = await import("@hot-updater/firebase/storage/functions");
const edge = await import("@hot-updater/supabase/storage/edge");
const input = { environment: {}, bindings: {} };
if (node.createNodeStorageContext({ environment: {} }).target !== "node") process.exit(1);
if (lambda.createLambdaStorageContext(input).target !== "functions") process.exit(1);
if (worker.createWorkerStorageContext(input).target !== "worker") process.exit(1);
if (functions.createFunctionsStorageContext(input).target !== "functions") process.exit(1);
if (edge.createEdgeStorageContext({ ...input, target: "edge" }).target !== "edge") process.exit(1);
if (edge.createEdgeStorageContext({ ...input, target: "worker" }).target !== "worker") process.exit(1);`,
      true,
    );
  });

  it.each(unsupportedDefaultEntries)(
    "fails the default %s Storage entry with actionable guidance",
    async (packageName, exportName, message) => {
      const packageDirectory = consumer.packageDirectories.get(packageName);
      if (packageDirectory === undefined) {
        throw new TypeError(`Missing installed package ${packageName}.`);
      }
      const parsed: unknown = JSON.parse(
        await readFile(path.join(packageDirectory, "package.json"), "utf8"),
      );
      const storageExport = readProperty(
        readProperty(parsed, "exports"),
        "./storage",
      );
      const target = resolveExportTarget(storageExport, ["import"]);
      await access(path.join(packageDirectory, target));
      const moduleUrl = pathToFileURL(path.join(packageDirectory, target)).href;

      await runNode(
        consumer.directory,
        `const api = await import(${JSON.stringify(moduleUrl)});
try {
  api[${JSON.stringify(exportName)}]({});
  process.exit(1);
} catch (error) {
  if (!(error instanceof Error) || error.message !== ${JSON.stringify(message)}) {
    throw error;
  }
}`,
        true,
      );
    },
  );

  it.each([
    ["storage-consumer.mts", storageTypeFixture],
    ["storage-consumer.cts", storageCommonJsTypeFixture],
  ])("type-checks %s through packed declarations", async (file, source) => {
    const consumerFile = path.join(consumer.directory, file);
    await writeFile(consumerFile, source);
    const typescriptCli = path.join(
      workspaceRoot,
      "node_modules/typescript/bin/tsc",
    );
    await access(typescriptCli);
    await execFileAsync(
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
        "true",
        "--strict",
        "--target",
        "ES2022",
        "--types",
        "node",
        file,
      ],
      { cwd: consumer.directory },
    );
  });
});
