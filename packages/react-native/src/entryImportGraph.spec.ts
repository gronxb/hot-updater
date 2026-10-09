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

  it("runs plugins on the host and exports the built-in Insights client", () => {
    // Metro does not tree-shake, so every app bundles the Insights client.
    expect(graph).toContain("pluginHost.ts");
    expect(readFileSync(join(sourceRoot, "index.ts"), "utf8")).toContain(
      'from "@hot-updater/plugin-insights/client";',
    );
  });

  it("sends no Insights request outside the Insights plugin", () => {
    const insightsCode = graph.filter((file) => {
      const source = readFileSync(join(sourceRoot, file), "utf8");
      return /["'`/]events["'`]/.test(source);
    });
    expect(insightsCode).toEqual([]);
  });
});

// Client plugins import the contract from @hot-updater/protocol; the root
// entry re-exports its names for app code.
describe("the client plugin names of the root entry", () => {
  it("are names @hot-updater/protocol exports", () => {
    /** The names a file re-exports from `specifier`, without `type`. */
    const reexported = (file: string, specifier: string) => {
      const block = new RegExp(
        `export\\s*\\{([^}]*)\\}\\s*from\\s*["']${specifier}["']`,
      ).exec(readFileSync(join(sourceRoot, file), "utf8"))?.[1];
      return (block ?? "")
        .split(",")
        .map((name) => name.trim().replace(/^type\s+/, ""))
        .filter((name) => name.length > 0);
    };
    const rootNames = reexported("index.ts", "\\./clientPlugin");
    // The contract lives in @hot-updater/protocol, which loads no React Native.
    const contractNames = reexported(
      "clientPlugin.ts",
      "@hot-updater/protocol",
    );

    expect(rootNames).toEqual([
      "defineClientPlugin",
      "AppReadyResult",
      "BundleDownloadedInfo",
      "ClientPluginApi",
      "ClientPluginApis",
      "HotUpdaterClientContext",
      "HotUpdaterClientHooks",
      "HotUpdaterClientPlugin",
      "HotUpdaterClientSetup",
      "HotUpdaterClientStorage",
      "ReleaseTransitionKind",
      "UpdateCheckResult",
      "UpdateError",
      "UpdateErrorReason",
      "UpdateErrorStage",
      "UpdateHttpResponse",
      "UpdateStrategy",
    ]);
    expect(contractNames).toEqual(expect.arrayContaining(rootNames ?? []));
  });
});
