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

  it("bundles not the plugin host entry, which only test-utils imports", () => {
    expect(graph).not.toContain("plugin-host.ts");
  });

  it("sends no Insights request", () => {
    const insightsCode = graph.filter((file) => {
      const source = readFileSync(join(sourceRoot, file), "utf8");
      return /["'`/]events["'`]/.test(source);
    });
    expect(insightsCode).toEqual([]);
  });
});

describe("@hot-updater/react-native/plugin-host entry", () => {
  const graph = [...collectGraph(join(sourceRoot, "plugin-host.ts"))].map(
    (file) => relative(sourceRoot, file),
  );

  it("loads the app's plugin host without React Native or the native module", () => {
    expect(graph).toContain("createPluginHost.ts");
    expect(graph).not.toContain("native.ts");
    const reactNativeImports = graph.filter((file) =>
      /\bfrom\s*["']react-native["']/.test(
        readFileSync(join(sourceRoot, file), "utf8"),
      ),
    );
    expect(reactNativeImports).toEqual([]);
  });
});

describe("@hot-updater/react-native/client-plugin entry", () => {
  const entry = join(sourceRoot, "client-plugin.ts");
  const graph = [...collectGraph(entry)].map((file) =>
    relative(sourceRoot, file),
  );

  it("loads the plugin contract without React Native or the native module", () => {
    expect(graph.sort()).toEqual(["client-plugin.ts", "clientPlugin.ts"]);
    const reactNativeImports = graph.filter((file) =>
      /\bfrom\s*["']react-native["']/.test(
        readFileSync(join(sourceRoot, file), "utf8"),
      ),
    );
    expect(reactNativeImports).toEqual([]);
  });

  it("exports every plugin name the root entry still exports for the app", () => {
    const rootNames = /export\s*\{([^}]*)\}\s*from\s*["']\.\/clientPlugin["']/
      .exec(readFileSync(join(sourceRoot, "index.ts"), "utf8"))?.[1]
      ?.split(",")
      .map((name) => name.trim().replace(/^type\s+/, ""))
      .filter((name) => name.length > 0);
    const contractNames = [
      ...readFileSync(join(sourceRoot, "clientPlugin.ts"), "utf8").matchAll(
        /^export\s+(?:const|function|type|interface)\s+(\w+)/gm,
      ),
    ].map((match) => match[1]);

    expect(rootNames).toEqual([
      "defineClientPlugin",
      "AppReadyResult",
      "BundleDownloadedInfo",
      "HotUpdaterClientContext",
      "HotUpdaterClientHooks",
      "HotUpdaterClientPlugin",
      "HotUpdaterClientStorage",
      "ReleaseTransitionKind",
      "UpdateCheckResult",
      "UpdateError",
      "UpdateErrorReason",
      "UpdateErrorStage",
      "UpdateStrategy",
    ]);
    expect(readFileSync(entry, "utf8")).toContain(
      'export * from "./clientPlugin";',
    );
    expect(contractNames).toEqual(expect.arrayContaining(rootNames ?? []));
  });
});
