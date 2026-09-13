import { pluginReactLynx } from "@lynx-js/react-rsbuild-plugin";
import { defineConfig } from "@lynx-js/rspeedy";

const isPublic = process.env.HOT_UPDATER_SPIKE_SDK !== "0";
const resourceSet =
  process.env.HOT_UPDATER_SPIKE_RESOURCES ?? (isPublic ? "sdk3" : "basic");
const baseURL = process.env.HOT_UPDATER_SDK_BASE_URL;
if (isPublic && (!baseURL || !/^https?:\/\//i.test(baseURL))) {
  throw new Error(
    "Set HOT_UPDATER_SDK_BASE_URL to an explicit HTTP(S) endpoint for the public Lynx example.",
  );
}

export default defineConfig({
  environments: { lynx: {} },
  source: {
    entry: {
      main: isPublic ? "./react/src/sdk.tsx" : "./react/src/index.tsx",
    },
    define: {
      __SDK_RESOURCES__: JSON.stringify(["sdk2", "sdk3"].includes(resourceSet)),
      __SDK_BASE_URL__: JSON.stringify(baseURL ?? ""),
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
    distPath: { root: process.env.HOT_UPDATER_BUILD_DIR ?? "dist/react" },
    assetPrefix:
      process.env.HOT_UPDATER_SPIKE_ASSET_PREFIX ?? "hot-updater:///",
    filenameHash: false,
    filename: { bundle: "[name].lynx.bundle" },
  },
  plugins: [pluginReactLynx()],
});
