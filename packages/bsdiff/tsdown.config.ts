import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    node: "src/node.ts",
    bun: "src/bun.ts",
    deno: "src/deno.ts",
    worker: "src/worker.ts",
    hdiff: "src/hdiff.ts",
    errors: "src/errors.ts",
    precompiled: "src/precompiled.ts",
    "internal/bsdiff": "src/internal/bsdiff.ts",
    "internal/bytes": "src/internal/bytes.ts",
    "internal/hermes-validate": "src/internal/hermes-validate.ts",
  },
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
  inputOptions(options) {
    const external = Array.isArray(options.external)
      ? options.external
      : options.external
        ? [options.external]
        : [];
    return {
      ...options,
      external: [...external, /\.wasm$/],
    };
  },
});
