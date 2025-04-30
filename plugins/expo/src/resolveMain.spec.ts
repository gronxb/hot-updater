import * as fs from "fs";
import { tmpdir } from "os";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { resolveMain } from "../src/resolveMain";

// Utility to create a temporary directory
function makeTempDir(prefix = "vitest-"): string {
  return fs.mkdtempSync(path.join(tmpdir(), prefix));
}

describe("resolveMain", () => {
  it("direct resolution: when index.js exists", () => {
    const dir = makeTempDir();
    const indexPath = path.join(dir, "index.js");
    fs.writeFileSync(indexPath, "module.exports = 42;");
    const resolved = resolveMain(dir);
    expect(resolved).toBe(require.resolve(indexPath));
  });

  it('fallback to "main" file path', () => {
    const dir = makeTempDir();
    const libDir = path.join(dir, "lib");
    fs.mkdirSync(libDir, { recursive: true });
    const mainFile = path.join(libDir, "main.js");
    fs.writeFileSync(mainFile, 'exports.foo = "bar";');
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ main: "lib/main.js" }),
    );

    const resolved = resolveMain(dir);
    expect(resolved).toBe(require.resolve(mainFile));
  });

  it("resolves module specifier: local node_modules/foo/index.js", () => {
    const dir = makeTempDir();
    // Create node_modules/foo/index.js
    const fooDir = path.join(dir, "node_modules", "foo");
    fs.mkdirSync(fooDir, { recursive: true });
    const fooIndex = path.join(fooDir, "index.js");
    fs.writeFileSync(fooIndex, 'module.exports = "hello from foo";');
    // Set "foo" as main in package.json
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ main: "foo" }),
    );

    const expected = require.resolve("foo", { paths: [dir] });
    const resolved = resolveMain(dir);
    expect(resolved).toBe(expected);
  });

  it("error: empty directory (no index or package.json)", () => {
    const dir = makeTempDir();
    expect(() => resolveMain(dir)).toThrow(/Cannot resolve module at/);
  });

  it("error: invalid JSON format in package.json", () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, "package.json"), "{ invalid json ");
    expect(() => resolveMain(dir)).toThrow(
      /Failed to read or parse package\.json/,
    );
  });

  it("error: missing or empty main field", () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({}));
    expect(() => resolveMain(dir)).toThrow(/No valid "main" field/);
  });
});
