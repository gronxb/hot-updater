import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);
const sourceRoots = [
  "packages/core/src",
  "packages/server/src",
  "plugins/plugin-core/src",
  "packages/cli-tools/src",
  "packages/hot-updater/src",
  "packages/hot-updater/scripts",
];
const forbiddenPolicies = [
  /react[- ]?native/i,
  /hermes/i,
  /metro/i,
  /\bexpo\b/i,
  /sparkling/i,
  /\.hbc/i,
  /getJSBundleFile/,
  /HotUpdater\.bundleURL/,
  /AppDelegate/,
  /MainApplication/,
];

const sourceFiles = async (root: string): Promise<string[]> => {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(target);
      } else if (
        /\.(?:ts|mts|cts|mjs|cjs)$/.test(entry.name) &&
        !/\.(?:spec|test)\.[^.]+$/.test(entry.name)
      ) {
        files.push(target);
      }
    }
  };
  await visit(path.join(repositoryRoot, root));
  return files;
};

describe("neutral package boundary", () => {
  it("keeps framework and runtime policy in application integrations", async () => {
    const violations: string[] = [];
    for (const sourceRoot of sourceRoots) {
      for (const file of await sourceFiles(sourceRoot)) {
        const contents = await fs.readFile(file, "utf8");
        for (const policy of forbiddenPolicies) {
          if (policy.test(contents)) {
            violations.push(
              `${path.relative(repositoryRoot, file)} matches ${policy.source}`,
            );
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("uses runtime-neutral package descriptions", async () => {
    const manifests = await Promise.all(
      [
        "packages/core/package.json",
        "packages/server/package.json",
        "plugins/plugin-core/package.json",
        "packages/cli-tools/package.json",
        "packages/hot-updater/package.json",
      ].map(async (manifest) => ({
        manifest,
        value: JSON.parse(
          await fs.readFile(path.join(repositoryRoot, manifest), "utf8"),
        ),
      })),
    );
    const violations = manifests.flatMap(({ manifest, value }) =>
      forbiddenPolicies.flatMap((policy) =>
        policy.test(
          JSON.stringify({
            description: value.description,
            keywords: value.keywords,
          }),
        )
          ? [`${manifest} matches ${policy.source}`]
          : [],
      ),
    );
    expect(violations).toEqual([]);
  });
});
