import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const workspaceRoot = path.resolve(import.meta.dirname, "../../../..");

const readMatchingFiles = async (
  directory: string,
  include: (file: string) => boolean,
): Promise<string> => {
  const entries = await readdir(directory, {
    recursive: true,
    withFileTypes: true,
  });
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name))
    .filter(include)
    .sort();
  return (await Promise.all(files.map((file) => readFile(file, "utf8")))).join(
    "\n",
  );
};

const isProductTypeScript = (file: string): boolean =>
  file.endsWith(".ts") &&
  !file.endsWith(".spec.ts") &&
  !file.endsWith(".test.ts") &&
  !file.endsWith(".testFixtures.ts");

const isDeclaration = (file: string): boolean =>
  file.endsWith(".d.mts") || file.endsWith(".d.cts");

const serverForbidden =
  /Analytics|BundleEvent|Installation(?:Search|History|Overview)|analyticsCapability|eventIngestion|["'`]\/events/;
const pluginCoreForbidden =
  /AnalyticsFeature|AnalyticsProvider|BundleEvent(?:Summary|Analytics|Overview)|Installation(?:Search|History|Overview)|analyticsProviderToken|databaseAnalyticsSupport/;

const readProperty = (target: unknown, key: string): unknown => {
  if (typeof target !== "object" || target === null) {
    throw new TypeError(`Cannot read ${key} from a non-object value.`);
  }
  return Reflect.get(target, key);
};

describe("server plugin static package boundary", () => {
  it("keeps Analytics out of every server dependency section", async () => {
    // Given / When
    const parsed: unknown = JSON.parse(
      await readFile(
        path.join(workspaceRoot, "packages/server/package.json"),
        "utf8",
      ),
    );
    const dependencySections = [
      readProperty(parsed, "dependencies"),
      readProperty(parsed, "devDependencies"),
      readProperty(parsed, "peerDependencies"),
    ];

    // Then
    for (const dependencies of dependencySections) {
      expect(dependencies).not.toHaveProperty("@hot-updater/analytics");
    }
  });

  it("keeps Analytics identifiers out of server product source", async () => {
    // Given / When
    const source = await readMatchingFiles(
      path.join(workspaceRoot, "packages/server/src"),
      isProductTypeScript,
    );

    // Then
    expect(source).not.toMatch(serverForbidden);
  });

  it("keeps Analytics identifiers out of server declarations", async () => {
    // Given / When
    const declarations = await readMatchingFiles(
      path.join(workspaceRoot, "packages/server/dist"),
      isDeclaration,
    );

    // Then
    expect(declarations).not.toMatch(serverForbidden);
  });

  it("keeps high-level Analytics APIs out of plugin-core declarations", async () => {
    // Given / When
    const declarations = await readMatchingFiles(
      path.join(workspaceRoot, "plugins/plugin-core/dist"),
      isDeclaration,
    );

    // Then
    expect(declarations).not.toMatch(pluginCoreForbidden);
  });
});
