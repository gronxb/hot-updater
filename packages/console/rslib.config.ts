import { defineConfig } from "@rslib/core";
import UnpluginTypiaRspackPlugin from "@ryoppippi/unplugin-typia/rspack";

export default defineConfig({
  tools: {
    rspack: {
      plugins: [UnpluginTypiaRspackPlugin()],
    },
  },
  lib: [
    {
      source: {
        entry: {
          index: "./src-server/index.ts",
        },
      },
      output: {
        cleanDistPath: false,
      },
      format: "esm",
      dts: true,
      shims: {
        esm: {
          __dirname: true,
          __filename: true,
          require: true,
        },
      },
    },
    {
      source: {
        entry: {
          index: "./src-server/index.ts",
        },
      },
      output: {
        cleanDistPath: false,
      },
      format: "cjs",
      dts: true,
      shims: {
        cjs: {
          "import.meta.url": true,
        },
      },
    },
  ],
});
