import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    config: "./src/config.ts",
    index: "./src/index.ts",
    plugins: "./src/plugins.ts",
  },
  deps: {
    onlyBundle: false,
  },
  exports: {
    bin: {
      "hot-updater": "./src/index.ts",
    },
    customExports: {
      ".": {
        types: "./dist/config.d.mts",
        import: "./dist/config.mjs",
        require: "./dist/config.mjs",
      },
      "./plugins": {
        types: "./dist/plugins.d.mts",
        import: "./dist/plugins.mjs",
        require: "./dist/plugins.mjs",
      },
    },
    exclude: ["index", "plugins"],
    inlinedDependencies: true,
    legacy: true,
  },
  format: ["esm"],
  outDir: "dist",
  dts: true,
  failOnWarn: true,
  shims: true,
});
