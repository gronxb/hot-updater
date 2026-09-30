import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const sourceRoot = dirname(fileURLToPath(import.meta.url));

/** Every relative module a file imports, statically or dynamically. */
const readImports = (file: string): string[] => {
  const source = readFileSync(file, "utf8");
  const specifiers = [
    ...source.matchAll(/\b(?:import|export)\s[^;]*?\bfrom\s*["']([^"']+)["']/g),
    ...source.matchAll(/\bimport\s*["']([^"']+)["']/g),
    ...source.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g),
  ].map((match) => match[1]!);
  return specifiers.filter((specifier) => specifier.startsWith("."));
};

const resolveModule = (from: string, specifier: string): string => {
  const base = resolve(dirname(from), specifier);
  const file = [
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
  ].find((path) => existsSync(path));
  if (file === undefined) {
    throw new Error(`Cannot resolve ${specifier} from ${from}`);
  }
  return file;
};

const collectGraph = (entry: string): Set<string> => {
  const seen = new Set<string>();
  const pending = [entry];
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const specifier of readImports(file)) {
      pending.push(resolveModule(file, specifier));
    }
  }
  return seen;
};

describe("@hot-updater/react-native root entry", () => {
  const graph = [...collectGraph(join(sourceRoot, "index.ts"))].map((file) =>
    relative(sourceRoot, file),
  );

  it("bundles no plugin, since Metro does not tree-shake", () => {
    expect(graph).toContain("pluginHost.ts");
    expect(graph.filter((file) => file.startsWith("plugins/"))).toEqual([]);
  });

  it("sends no Insights request", () => {
    const insightsCode = graph.filter((file) => {
      const source = readFileSync(join(sourceRoot, file), "utf8");
      return /["'`/]events["'`]|x-hot-updater-insights/.test(source);
    });
    expect(insightsCode).toEqual([]);
  });
});
