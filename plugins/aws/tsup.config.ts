import { defineConfig } from "tsup";

export default defineConfig([{
  entry: ["src/index.ts", "src/sdk.ts"],
  format: ["esm", "cjs"],
  outDir: "dist",
  dts: true,
  banner: {
    js: `import { createRequire } from 'module'; const require = createRequire(import.meta.url);`,
  },
}, {
  entry: ["lambda/index.ts"],
  format: ["cjs"],
  outDir: "dist/lambda",
  sourcemap: false,
  splitting: false,
  clean: true,
  dts: false,
  external: ["aws-sdk"],
  noExternal: ["@hot-updater/js", "@hot-updater/core"]
}]);
