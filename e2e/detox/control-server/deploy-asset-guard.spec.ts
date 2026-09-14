import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { copyE2eFixtures } from "../../../examples/lynx/scripts/copy-e2e-fixtures.ts";
import { PAX_LONG_ASSET_REQUIRE_PATH } from "../pax-long-path-fixture.ts";
import {
  type BundleProfile,
  createDeployAssetGuardSource,
} from "./deploy-asset-guard.ts";
import { restoreDeployFixtures } from "./deploy-fixture-reset.ts";

const repoDir = path.resolve(__dirname, "../../..");
const assetProfiles = [
  "archive300mb",
  "multiAssetReplacement",
  "sizeAwareLargeDiff",
] as const satisfies readonly BundleProfile[];
const emptyGuard = [
  "/* E2E_DEPLOY_ASSET_GUARD_START */",
  "  /* E2E_DEPLOY_ASSET_GUARD_END */",
].join("\n");
const compareText = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0;

function validCompilerGraph() {
  const pages = ["detail", "main"];
  const compilerEntries = pages.flatMap((page) => [
    page,
    `${page}__main-thread`,
  ]);
  const nodes = [
    ...pages.map((page) => ({
      id: `page:${page}.lynx.bundle`,
      kind: "page",
      path: `${page}.lynx.bundle`,
    })),
    ...compilerEntries.flatMap((name) => [
      { id: `entry:${name}`, kind: "entry", name },
      { id: `chunk:${name}`, kind: "chunk", name },
    ]),
  ].sort((left, right) => compareText(left.id, right.id));
  const edges = pages
    .flatMap((page) =>
      [page, `${page}__main-thread`].flatMap((name) => [
        {
          from: `page:${page}.lynx.bundle`,
          kind: "compiledBy",
          to: `entry:${name}`,
        },
        {
          from: `entry:${name}`,
          kind: "contains",
          to: `chunk:${name}`,
        },
      ]),
    )
    .sort((left, right) =>
      compareText(JSON.stringify(left), JSON.stringify(right)),
    );
  return {
    schemaVersion: 1,
    source: "@rspack/core:chunkGraph",
    compilerVersion: "1.7.11",
    entries: pages.map((page) => ({
      entry: `${page}.lynx.bundle`,
      compilerEntries: [page, `${page}__main-thread`].sort(),
      resources: [`${page}.lynx.bundle`],
    })),
    auxiliaryAssets: [],
    edges,
    nodes,
  };
}

async function writeValidCompilerOutput(outDir: string) {
  await fs.mkdir(outDir, { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(outDir, "detail.lynx.bundle"), "detail"),
    fs.writeFile(path.join(outDir, "main.lynx.bundle"), "main"),
  ]);
  await fs.writeFile(
    `${outDir}.page-graph.json`,
    JSON.stringify(validCompilerGraph()),
  );
}

describe("Detox deploy asset guard", () => {
  it.each(assetProfiles)(
    "keeps the Lynx %s source guard empty",
    (bundleProfile) => {
      const source = createDeployAssetGuardSource(
        bundleProfile,
        "com.hotupdater.lynxexample",
      );

      expect(source).toBe(emptyGuard);
      expect(source).not.toContain("require(");
    },
  );

  it.each([
    ["archive300mb", ["../test/_fixture-archive-300mb-random.bmp"]],
    [
      "multiAssetReplacement",
      [
        "../test/_fixture-multi-asset-a.bmp",
        "../test/_fixture-multi-asset-b.bmp",
        "../test/_fixture-multi-asset-c.bmp",
        PAX_LONG_ASSET_REQUIRE_PATH,
      ],
    ],
    [
      "sizeAwareLargeDiff",
      ["../test/_fixture-size-aware-large-compressible.bmp"],
    ],
  ] as const)(
    "retains React Native %s asset requires",
    (bundleProfile, requirePaths) => {
      const source = createDeployAssetGuardSource(
        bundleProfile,
        "com.hotupdater.example",
      );

      expect(
        source.match(/Image\.resolveAssetSource\(require\(/g),
      ).toHaveLength(requirePaths.length);
      for (const requirePath of requirePaths) {
        expect(source).toContain(`require(${JSON.stringify(requirePath)})`);
      }
    },
  );

  it("copies each profile after validation and omits its fixtures from the next default build", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "lynx-fixtures-"));
    const exampleDir = path.join(root, "example");
    const testDir = path.join(exampleDir, "src/test");
    const profileFixtures = [
      ["archive300mb", ["_fixture-archive-300mb-random.bmp"]],
      [
        "multiAssetReplacement",
        [
          "_fixture-multi-asset-a.bmp",
          "_fixture-multi-asset-b.bmp",
          "_fixture-multi-asset-c.bmp",
          path.basename(PAX_LONG_ASSET_REQUIRE_PATH),
        ],
      ],
      ["sizeAwareLargeDiff", ["_fixture-size-aware-large-compressible.bmp"]],
    ] as const;

    try {
      await fs.mkdir(testDir, { recursive: true });
      await fs.writeFile(
        path.join(testDir, "keep.txt"),
        "not a deploy fixture",
      );
      const e2eAssetsUrl = pathToFileURL(
        path.join(repoDir, "examples/lynx/scripts/e2e-assets.mjs"),
      ).href;
      const { finishLynxE2eBundle } = (await import(e2eAssetsUrl)) as {
        finishLynxE2eBundle: (outDir: string) => Promise<{
          pageEssentialResources: readonly unknown[];
        }>;
      };

      for (const [bundleProfile, fixtureNames] of profileFixtures) {
        const expectedNames = [...fixtureNames].sort();
        const profileOutDir = path.join(root, `${bundleProfile}-output`);
        const defaultOutDir = path.join(
          root,
          `${bundleProfile}-default-output`,
        );
        await Promise.all(
          fixtureNames.map((name) =>
            fs.writeFile(path.join(testDir, name), name),
          ),
        );
        await writeValidCompilerOutput(profileOutDir);
        const compilerResult = await finishLynxE2eBundle(profileOutDir);

        expect(compilerResult.pageEssentialResources).toHaveLength(2);
        await copyE2eFixtures(exampleDir, profileOutDir);
        expect(
          await fs.readdir(path.join(profileOutDir, "assets/src/test")),
        ).toEqual(expectedNames);
        expect(await fs.readdir(path.join(profileOutDir, "raw"))).toEqual(
          expectedNames
            .map((name) => `src_test_${name.replaceAll("-", "")}`)
            .sort(),
        );

        await restoreDeployFixtures(
          fixtureNames.map((name) => ({
            backupPath: null,
            targetPath: path.join(testDir, name),
          })),
        );
        expect(await fs.readdir(testDir)).toEqual(["keep.txt"]);

        await writeValidCompilerOutput(defaultOutDir);
        await finishLynxE2eBundle(defaultOutDir);
        await copyE2eFixtures(exampleDir, defaultOutDir);
        expect(
          await fs.readdir(path.join(defaultOutDir, "assets/src/test")),
        ).toEqual([]);
        expect(await fs.readdir(path.join(defaultOutDir, "raw"))).toEqual([]);
      }
    } finally {
      await fs.rm(root, { force: true, recursive: true });
    }
  });
});
