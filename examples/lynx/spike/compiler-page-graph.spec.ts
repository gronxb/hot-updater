import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { afterAll, describe, expect, it } from "vitest";

import {
  finishSpike,
  readSpikePageContract,
} from "../scripts/spike-assets.mjs";

const exampleRoot = path.resolve(import.meta.dirname, "..");
const testRoot = path.join(
  exampleRoot,
  ".hot-updater",
  `async-graph-${process.pid}`,
);
const run = promisify(execFile);

afterAll(() => fs.rm(testRoot, { recursive: true, force: true }));

describe("compiler-derived async page ownership", () => {
  it.each(["named", "anonymous", "split-initial", "split-async"])(
    "preserves nested/shared %s imports without changing startup requirements",
    async (mode) => {
      const root = path.join(testRoot, mode);
      const output = path.join(root, "dist");
      const comment = (name: string) =>
        mode !== "anonymous" ? `/* webpackChunkName: "${name}" */` : "";
      const split = mode.startsWith("split-");
      const sharedInitial = mode === "split-initial";
      const initialImport = sharedInitial
        ? 'import { initial } from "./initial"; globalThis.initial = initial;'
        : "";
      const splitChunks = split
        ? {
            cacheGroups: {
              common: {
                test: sharedInitial ? "initial" : "vendor",
                name: sharedInitial ? "common-initial" : "common-async",
                chunks: sharedInitial ? "initial" : "async",
                enforce: true,
              },
            },
          }
        : false;
      await fs.mkdir(root, { recursive: true });
      await fs.symlink(
        path.join(exampleRoot, "node_modules"),
        path.join(root, "node_modules"),
      );
      await Promise.all([
        fs.writeFile(
          path.join(root, "main.ts"),
          split
            ? `${initialImport} globalThis.loadMain = () => import(/* webpackChunkName: "main-private" */ "./main-private");`
            : `globalThis.loadMain = () => import(${comment("lazy")} "./lazy");`,
        ),
        fs.writeFile(
          path.join(root, "detail.ts"),
          split
            ? `${initialImport} globalThis.loadDetail = () => import(/* webpackChunkName: "detail-private" */ "./detail-private");`
            : `globalThis.loadDetail = () => import(${comment("shared")} "./shared");`,
        ),
        fs.writeFile(
          path.join(root, "lazy.ts"),
          `export const loadShared = () => import(${comment("shared")} "./shared");`,
        ),
        fs.writeFile(
          path.join(root, "shared.ts"),
          'export const value = "shared-A";',
        ),
        fs.writeFile(
          path.join(root, "initial.ts"),
          'export const initial = "shared-initial";',
        ),
        fs.writeFile(
          path.join(root, "vendor.ts"),
          'export const value = "shared-vendor";',
        ),
        fs.writeFile(
          path.join(root, "main-private.ts"),
          'import { value } from "./vendor"; export const result = "main-" + value;',
        ),
        fs.writeFile(
          path.join(root, "detail-private.ts"),
          'import { value } from "./vendor"; export const result = "detail-" + value;',
        ),
        fs.writeFile(
          path.join(root, "lynx.config.mjs"),
          `
import { defineConfig } from "@lynx-js/rspeedy";
import { pluginVueLynx } from "vue-lynx/plugin";
import { compilerPageGraphPlugin, compilerPageResourceEntries } from ${JSON.stringify(path.join(import.meta.dirname, "compiler-page-graph.mjs"))};
const splitChunks = ${JSON.stringify(splitChunks)};
if (splitChunks) splitChunks.cacheGroups.common.test = /${sharedInitial ? "initial" : "vendor"}\\.ts$/;
export default defineConfig({
  mode: "production",
  environments: { lynx: {} },
  source: { entry: { main: "./main.ts", detail: "./detail.ts" } },
  output: {
    distPath: { root: ${JSON.stringify(output)} },
    filenameHash: false,
    filename: { bundle: "[name].lynx.bundle" },
    assetPrefix: "hot-updater:///"
  },
  tools: { rspack: { optimization: { splitChunks } } },
  plugins: [pluginVueLynx({ enableIFR: true }), compilerPageGraphPlugin({
    resourceEntries: compilerPageResourceEntries("basic")
  })]
});
`,
        ),
      ]);
      await run(
        process.execPath,
        [
          path.join(
            exampleRoot,
            "node_modules/@lynx-js/rspeedy/bin/rspeedy.js",
          ),
          "build",
          "--config",
          "lynx.config.mjs",
          "--environment",
          "lynx",
        ],
        { cwd: root, env: { ...process.env, HOT_UPDATER_SPIKE_VARIANT: "A" } },
      );
      const report = await finishSpike(output, "vue", "A", {
        resourceSet: "basic",
      });
      const [detail, main] = report.compilerGraph.entries;
      if (split) {
        expect(main.asyncAssets).toEqual([
          expect.stringMatching(/^async\/main-private\./),
        ]);
        expect(detail.asyncAssets).toEqual([
          expect.stringMatching(/^async\/detail-private\./),
        ]);
        const common = sharedInitial
          ? "chunk:common-initial"
          : "chunk:common-async";
        const owners = report.compilerGraph.edges.filter(
          (edge: { to: string; kind: string }) =>
            edge.to === common && edge.kind === "contains",
        );
        expect(
          new Set(owners.map((edge: { from: string }) => edge.from)).size,
        ).toBeGreaterThanOrEqual(2);
      } else {
        expect(detail.asyncAssets.length).toBeGreaterThan(0);
        expect(main.asyncAssets.length).toBeGreaterThan(
          detail.asyncAssets.length,
        );
        expect(main.asyncAssets).toEqual(
          expect.arrayContaining(detail.asyncAssets),
        );
      }
      expect(report.compilerGraph.auxiliaryAssets).toEqual([]);
      expect(report.pageEssentialResources).toEqual([
        { entry: "detail.lynx.bundle", resources: ["detail.lynx.bundle"] },
        {
          entry: "main.lynx.bundle",
          resources: ["assets/probe.png", "main.lynx.bundle"],
        },
      ]);
      await expect(readSpikePageContract(output)).resolves.toMatchObject({
        pageEssentialResources: report.pageEssentialResources,
      });
      await fs.rm(path.join(output, detail.asyncAssets[0]));
      await expect(readSpikePageContract(output)).rejects.toThrow();
    },
    30000,
  );
});
