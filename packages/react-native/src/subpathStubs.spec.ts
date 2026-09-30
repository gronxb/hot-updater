import { readFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const readJson = (path: string) =>
  JSON.parse(readFileSync(join(packageRoot, path), "utf8")) as Record<
    string,
    unknown
  >;

interface ExportTarget {
  readonly types: string;
  readonly default: string;
}

const packageJson = readJson("package.json") as {
  readonly exports: Record<
    string,
    {
      readonly source: string;
      readonly import: ExportTarget;
      readonly require: ExportTarget;
    }
  >;
  readonly files: readonly string[];
};

// A resolver that ignores `exports`, such as Metro without package exports,
// finds a subpath through a directory of its own with a package.json.
describe.each(["client-plugin", "plugins/insights"])(
  "the %s subpath directory",
  (subpath) => {
    const stub = readJson(`${subpath}/package.json`);
    const target = packageJson.exports[`./${subpath}`]!;
    const fromStub = (path: unknown) =>
      posix.normalize(posix.join(subpath, String(path)));

    it("points at the files the export map names", () => {
      expect(stub.name).toBe(`@hot-updater/react-native/${subpath}`);
      expect(fromStub(stub.source)).toBe(posix.normalize(target.source));
      expect(fromStub(stub.main)).toBe(posix.normalize(target.require.default));
      expect(fromStub(stub.module)).toBe(
        posix.normalize(target.import.default),
      );
      expect(fromStub(stub.types)).toBe(posix.normalize(target.require.types));
    });

    it("is published", () => {
      expect(packageJson.files).toContain(subpath.split("/")[0]);
    });
  },
);
