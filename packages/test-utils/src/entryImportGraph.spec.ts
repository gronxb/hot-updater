import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const sourceRoot = dirname(fileURLToPath(import.meta.url));

/**
 * Every module a file imports at runtime; `import type` is erased, and
 * comments, such as a usage example, don't count.
 */
const readRuntimeImports = (file: string): string[] => {
  const source = readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  return [
    ...source.matchAll(
      /\b(?:import|export)\s+(?!type\b)[^;]*?\bfrom\s*["']([^"']+)["']/g,
    ),
    ...source.matchAll(/\bimport\s*["']([^"']+)["']/g),
    ...source.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g),
  ].map((match) => match[1]!);
};

const resolveModule = (from: string, specifier: string): string => {
  const base = resolve(dirname(from), specifier);
  const file = [`${base}.ts`, join(base, "index.ts")].find((path) =>
    existsSync(path),
  );
  if (file === undefined) {
    throw new Error(`Cannot resolve ${specifier} from ${from}`);
  }
  return file;
};

/** The package specifiers an entry's modules import at runtime, by module. */
const collectPackageImports = (entry: string): Map<string, string[]> => {
  const packages = new Map<string, string[]>();
  const pending = [join(sourceRoot, entry)];
  while (pending.length > 0) {
    const file = pending.pop()!;
    const name = relative(sourceRoot, file);
    if (packages.has(name)) continue;
    const imports = readRuntimeImports(file);
    packages.set(
      name,
      imports.filter((specifier) => !specifier.startsWith(".")),
    );
    for (const specifier of imports) {
      if (specifier.startsWith(".")) {
        pending.push(resolveModule(file, specifier));
      }
    }
  }
  return packages;
};

const importersOf = (
  graph: Map<string, string[]>,
  matches: (specifier: string) => boolean,
): string[] =>
  [...graph]
    .filter(([, specifiers]) => specifiers.some(matches))
    .map(([file]) => file);

const isReactNativeSdk = (specifier: string) =>
  specifier === "@hot-updater/react-native" ||
  specifier.startsWith("@hot-updater/react-native/");

describe("@hot-updater/test-utils entries", () => {
  it.each(["index.ts", "node.ts"])(
    "keeps the React Native SDK out of %s and its suites",
    (entry) => {
      expect(
        importersOf(collectPackageImports(entry), isReactNativeSdk),
      ).toEqual([]);
    },
  );

  it("runs client plugins on the SDK's plugin host without Vitest or React Native", () => {
    const graph = collectPackageImports("react-native.ts");

    expect(graph.get("setupClientPlugins.ts")).toEqual([
      "@hot-updater/react-native/plugin-host",
    ]);
    expect(
      importersOf(
        graph,
        (specifier) =>
          specifier === "vitest" ||
          specifier === "react-native" ||
          specifier === "@hot-updater/react-native",
      ),
    ).toEqual([]);
  });
});
