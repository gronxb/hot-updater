import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    config: "./src/config.ts",
    index: "./src/index.ts",
    plugins: "./src/plugins.ts",
    secrets: "./src/secrets.ts",
    signing: "./src/signing.ts",
  },
  deps: {
    neverBundle: [
      "@aws-sdk/client-kms",
      "@aws-sdk/credential-providers",
      "@google-cloud/kms",
      "google-auth-library",
    ],
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
      "./secrets": {
        types: "./dist/secrets.d.mts",
        import: "./dist/secrets.mjs",
        require: "./dist/secrets.mjs",
      },
      "./signing": {
        types: "./dist/signing.d.mts",
        import: "./dist/signing.mjs",
        require: "./dist/signing.mjs",
      },
    },
    exclude: ["index", "plugins", "secrets", "signing"],
    inlinedDependencies: true,
    legacy: true,
  },
  format: ["esm"],
  outDir: "dist",
  dts: true,
  failOnWarn: true,
  shims: true,
});
