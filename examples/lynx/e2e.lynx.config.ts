import { pluginReactLynx } from "@lynx-js/react-rsbuild-plugin";
import { defineConfig } from "@lynx-js/rspeedy";

export default defineConfig({
  environments: { lynx: {} },
  source: {
    entry: { main: "./src/e2eApp/index.tsx" },
    define: {
      __E2E_APP_BASE_URL__: JSON.stringify(
        process.env.HOT_UPDATER_E2E_APP_BASE_URL ??
          process.env.HOT_UPDATER_APP_BASE_URL ??
          "http://localhost:3007/hot-updater",
      ),
      __E2E_RUNTIME_CONFIG_URL__: JSON.stringify(
        process.env.HOT_UPDATER_E2E_RUNTIME_CONFIG_URL ??
          "http://localhost:3107/e2e/runtime-config",
      ),
      __E2E_OVERLAY_MARKER__: JSON.stringify(
        process.env.HOT_UPDATER_E2E_OVERLAY_MARKER ?? "",
      ),
      __E2E_BUILD_ID__: JSON.stringify(
        process.env.HOT_UPDATER_E2E_BUILD_ID ?? "",
      ),
    },
  },
  output: {
    distPath: { root: process.env.HOT_UPDATER_BUILD_DIR ?? "dist/e2e" },
    filenameHash: false,
    filename: { bundle: "[name].lynx.bundle" },
  },
  plugins: [pluginReactLynx()],
});
