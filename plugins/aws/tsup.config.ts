import type { Options } from "tsup";
import { defineConfig } from "tsup";

const getBanner: Options["banner"] = ({ format }) => ({
  js:
    format === "esm"
      ? `import { createRequire } from 'module'; const require = createRequire(import.meta.url);`
      : "",
});

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm", "cjs"],
    outDir: "dist",
    dts: true,
    banner: getBanner,
  },
  {
    entry: ["lambda/index.ts"],
    format: ["cjs"],
    outDir: "dist/lambda",
  },
  {
    entry: ["iac/index.ts"],
    format: ["esm", "cjs"],
    dts: true,
    outDir: "dist/iac",
    external: ["@hot-updater/aws"],
    banner: getBanner,
  },
]);
