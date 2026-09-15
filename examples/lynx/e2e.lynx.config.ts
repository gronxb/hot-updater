import { pluginLynxConfig } from "@lynx-js/config-rsbuild-plugin";
import { pluginReactLynx } from "@lynx-js/react-rsbuild-plugin";
import { defineConfig } from "@lynx-js/rspeedy";

import {
  compilerPageGraphPlugin,
  compilerPageResourceEntries,
} from "./spike/compiler-page-graph.mjs";

export default defineConfig({
  environments: { lynx: {} },
  source: {
    entry: {
      detail: "./src/e2eApp/detail.tsx",
      main: "./src/e2eApp/index.tsx",
    },
    define: {
      __E2E_OVERLAY_MARKER__: JSON.stringify(
        process.env.HOT_UPDATER_E2E_OVERLAY_MARKER ?? "",
      ),
    },
  },
  output: {
    distPath: { root: process.env.HOT_UPDATER_BUILD_DIR ?? "dist/e2e" },
    filenameHash: false,
    filename: { bundle: "[name].lynx.bundle" },
  },
  plugins: [
    pluginReactLynx(),
    pluginLynxConfig({ enableFetchAPIStandardStreaming: true }),
    compilerPageGraphPlugin({
      resourceEntries: compilerPageResourceEntries("sdk3"),
    }),
  ],
});
