import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    config: "./src/config.ts",
    index: "./src/index.ts",
    signing: "./src/signing.ts",
  },
  deps: {
    alwaysBundle: [/^@hot-updater\/(aws|cloudflare|firebase|supabase)\/init$/],
    neverBundle: ["@expo/fingerprint"],
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
      "./signing": {
        types: "./dist/signing.d.mts",
        import: "./dist/signing.mjs",
        require: "./dist/signing.mjs",
      },
    },
    exclude: ["index", "signing"],
    inlinedDependencies: true,
    legacy: true,
  },
  format: ["esm"],
  outDir: "dist",
  dts: true,
  failOnWarn: true,
  shims: true,
});
