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
    entry: ["src/index.ts", "src/utils/index.ts"],
    format: ["esm", "cjs"],
    dts: true,
    banner: getBanner,
  },
  {
    entry: ["iac/index.ts"],
    format: ["esm", "cjs"],
    dts: true,
    outDir: "dist/iac",
    external: ["@hot-updater/cloudflare"],
    banner: getBanner,
  },
]);
