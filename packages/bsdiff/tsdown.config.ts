import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    hdiff: "src/hdiff.ts",
    errors: "src/errors.ts",
    "internal/bsdiff": "src/internal/bsdiff.ts",
    "internal/bytes": "src/internal/bytes.ts",
    "internal/hermes-validate": "src/internal/hermes-validate.ts",
  },
  exports: true,
  format: "esm",
  dts: true,
  sourcemap: true,
  unbundle: true,
  clean: true,
  hash: false,
  fixedExtension: false,
  outExtensions() {
    return {
      js: ".js",
      dts: ".d.ts",
    };
  },
  platform: "node",
  outDir: "dist",
  tsconfig: "tsconfig.build.json",
});
