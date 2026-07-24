import { readFile } from "node:fs/promises";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

const workspaceRoot = path.resolve(import.meta.dirname, "../../../..");

type PackageName = "analytics" | "better-auth" | "plugin-core" | "server";
type PackageLocation = readonly [PackageName, string];
type PackageExportEntry = readonly [PackageName, unknown];

const packageLocations = [
  ["analytics", "packages/analytics"],
  ["better-auth", "packages/better-auth"],
  ["plugin-core", "plugins/plugin-core"],
  ["server", "packages/server"],
] satisfies readonly PackageLocation[];

let packageExports = new Map<PackageName, unknown>();

type ExportPaths = Readonly<{
  cjs: string;
  cts: string;
  mjs: string;
  mts: string;
}>;

const readProperty = (target: unknown, key: string): unknown => {
  if (typeof target !== "object" || target === null) {
    throw new TypeError(`Cannot read ${key} from a non-object value.`);
  }
  return Reflect.get(target, key);
};

const readPackageExports = async (
  location: PackageLocation,
): Promise<PackageExportEntry> => {
  const [name, directory] = location;
  const parsed: unknown = JSON.parse(
    await readFile(path.join(workspaceRoot, directory, "package.json"), "utf8"),
  );
  return [name, readProperty(parsed, "exports")];
};

const expectDualExport = (target: unknown, paths: ExportPaths): void => {
  if (typeof target !== "object" || target === null) {
    throw new TypeError("Package export target must be an object.");
  }
  const importCondition = Reflect.get(target, "import");
  const requireCondition = Reflect.get(target, "require");
  expect(importCondition).toEqual({
    default: paths.mjs,
    types: paths.mts,
  });
  expect(requireCondition).toEqual({
    default: paths.cjs,
    types: paths.cts,
  });
};

beforeAll(async () => {
  packageExports = new Map(
    await Promise.all(packageLocations.map(readPackageExports)),
  );
});

describe("server plugin declaration export conditions", () => {
  it.each([
    [
      "analytics",
      ".",
      {
        cjs: "./dist/index.cjs",
        cts: "./dist/index.d.cts",
        mjs: "./dist/index.mjs",
        mts: "./dist/index.d.mts",
      },
    ],
    [
      "analytics",
      "./provider",
      {
        cjs: "./dist/provider/index.cjs",
        cts: "./dist/provider/index.d.cts",
        mjs: "./dist/provider/index.mjs",
        mts: "./dist/provider/index.d.mts",
      },
    ],
    [
      "analytics",
      "./legacy-server",
      {
        cjs: "./dist/legacy-server/index.cjs",
        cts: "./dist/legacy-server/index.d.cts",
        mjs: "./dist/legacy-server/index.mjs",
        mts: "./dist/legacy-server/index.d.mts",
      },
    ],
    [
      "better-auth",
      ".",
      {
        cjs: "./dist/index.cjs",
        cts: "./dist/index.d.cts",
        mjs: "./dist/index.mjs",
        mts: "./dist/index.d.mts",
      },
    ],
    [
      "plugin-core",
      ".",
      {
        cjs: "./dist/index.cjs",
        cts: "./dist/index.d.cts",
        mjs: "./dist/index.mjs",
        mts: "./dist/index.d.mts",
      },
    ],
    [
      "plugin-core",
      "./internal/capabilities",
      {
        cjs: "./dist/internal/capabilities.cjs",
        cts: "./dist/internal/capabilities.d.cts",
        mjs: "./dist/internal/capabilities.mjs",
        mts: "./dist/internal/capabilities.d.mts",
      },
    ],
    [
      "server",
      ".",
      {
        cjs: "./dist/index.cjs",
        cts: "./dist/index.d.cts",
        mjs: "./dist/index.mjs",
        mts: "./dist/index.d.mts",
      },
    ],
    [
      "server",
      "./internal/first-party-plugin",
      {
        cjs: "./dist/internal/first-party-plugin.cjs",
        cts: "./dist/internal/first-party-plugin.d.cts",
        mjs: "./dist/internal/first-party-plugin.mjs",
        mts: "./dist/internal/first-party-plugin.d.mts",
      },
    ],
  ] satisfies readonly (readonly [PackageName, string, ExportPaths])[])(
    "pairs ESM and CommonJS runtime/declaration targets",
    (packageName, exportPath, paths) => {
      expectDualExport(
        readProperty(packageExports.get(packageName), exportPath),
        paths,
      );
    },
  );
});
