import { defineConfig } from "@lynx-js/rspeedy";
import { pluginOctane } from "@octanejs/rspeedy-plugin";

const { compilerPageGraphPlugin, compilerPageResourceEntries } = await import(
  process.env.HOT_UPDATER_COMPILER_GRAPH_PLUGIN ??
    new URL("../spike/compiler-page-graph.mjs", import.meta.url).href
);

const isPublic = process.env.HOT_UPDATER_SPIKE_SDK !== "0";
const resourceSet =
  process.env.HOT_UPDATER_SPIKE_RESOURCES ?? (isPublic ? "sdk3" : "basic");

export default defineConfig({
  mode: "production",
  environments: { lynx: {} },
  source: {
    entry: {
      detail: "./src/detail.ts",
      main: isPublic ? "./src/sdk.ts" : "./src/index.ts",
    },
    define: {
      __SDK_RESOURCES__: JSON.stringify(["sdk2", "sdk3"].includes(resourceSet)),
      __SPIKE_VARIANT__: JSON.stringify(
        process.env.HOT_UPDATER_SPIKE_VARIANT ?? "A",
      ),
      __SPIKE_BEHAVIOR__: JSON.stringify(
        process.env.HOT_UPDATER_SPIKE_BEHAVIOR ?? "normal",
      ),
      __SPIKE_RESOURCES__: JSON.stringify(
        ["resources", "fonts", "external", "dynamic"].includes(resourceSet),
      ),
      __SPIKE_LAZY__: JSON.stringify(resourceSet === "resources"),
      __SPIKE_EXTERNAL__: JSON.stringify(resourceSet === "external"),
      __SPIKE_DYNAMIC__: JSON.stringify(resourceSet === "dynamic"),
      __SPIKE_HTTP__: JSON.stringify(resourceSet === "http"),
      __SPIKE_ASSET_PREFIX__: JSON.stringify(
        process.env.HOT_UPDATER_SPIKE_ASSET_PREFIX ?? "hot-updater:///",
      ),
    },
  },
  output: {
    cleanDistPath: true,
    distPath: { root: process.env.HOT_UPDATER_BUILD_DIR },
    assetPrefix:
      process.env.HOT_UPDATER_SPIKE_ASSET_PREFIX ?? "hot-updater:///",
    filenameHash: false,
    filename: { bundle: "[name].lynx.bundle" },
    sourceMap: { js: false, css: false },
  },
  plugins: [
    pluginOctane({ dev: false, hmr: false }),
    compilerPageGraphPlugin({
      resourceEntries: compilerPageResourceEntries(resourceSet),
    }),
  ],
});
