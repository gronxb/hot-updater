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

const packageJson = readJson("package.json") as {
  readonly exports: Record<
    string,
    { readonly import: string; readonly require?: string }
  >;
  readonly files: readonly string[];
};

// A resolver that ignores `exports`, such as Metro without package exports,
// finds `./client` through a directory of its own with a package.json.
describe("the client subpath directory", () => {
  const stub = readJson("client/package.json");
  const target = packageJson.exports["./client"]!;
  const fromStub = (path: unknown) =>
    posix.normalize(posix.join("client", String(path)));

  it("points at the files the export map names", () => {
    expect(stub.name).toBe("@hot-updater/plugin-remote-config/client");
    expect(fromStub(stub.main)).toBe(posix.normalize(target.require!));
    expect(fromStub(stub.module)).toBe(posix.normalize(target.import));
    expect(fromStub(stub.types)).toBe(
      posix.normalize(target.require!).replace(/\.cjs$/, ".d.cts"),
    );
  });

  it("names only published files", () => {
    // Metro takes the first of its resolverMainFields a stub has, and does not
    // fall back when that file is missing, so a field such as `source` would
    // break apps that list it: the package publishes no `src`.
    expect(Object.keys(stub).sort()).toEqual([
      "main",
      "module",
      "name",
      "private",
      "types",
    ]);
    expect(packageJson.files).toEqual(
      expect.arrayContaining(["dist", "client"]),
    );
    expect(packageJson.files).not.toContain("src");
  });
});
