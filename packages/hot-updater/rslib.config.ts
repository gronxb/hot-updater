import { defineConfig } from "@rslib/core";

export default defineConfig({
  lib: [
    {
      format: "esm",
      dts: true,
      source: {
        entry: {
          index: "./src/index.ts",
          config: "./src/config.ts",
          "plugins/babel": "./src/plugins/babel.ts",
        },
      },
      shims: {
        esm: {
          __dirname: true,
          __filename: true,
          require: true,
        },
      },
    },
    {
      format: "cjs",
      dts: true,
      source: {
        entry: {
          index: "./src/index.ts",
          config: "./src/config.ts",
          "plugins/babel": "./src/plugins/babel.ts",
        },
      },
      shims: {
        cjs: {
          "import.meta.url": true,
        },
      },
    },
  ],
});
