import { pluginReactLynx } from "@lynx-js/react-rsbuild-plugin";
import { defineConfig } from "@lynx-js/rspeedy";

export default defineConfig({
  environments: { lynx: {} },
  source: {
    entry: { component: "./spike/dynamic-component.ts" },
    define: {
      __SPIKE_VARIANT__: JSON.stringify(process.env.HOT_UPDATER_SPIKE_VARIANT),
    },
  },
  output: {
    distPath: { root: process.env.HOT_UPDATER_DYNAMIC_DIR },
    assetPrefix: "hot-updater:///dynamic/",
    filenameHash: false,
    filename: { bundle: "[name].lynx.bundle" },
    sourceMap: { js: false },
  },
  plugins: [pluginReactLynx({ experimental_isLazyBundle: true })],
});
