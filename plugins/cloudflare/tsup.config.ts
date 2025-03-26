import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/index.ts", "src/utils/index.ts"],
    format: ["esm", "cjs"],
    dts: true,
    banner: {
      js: `import { createRequire } from 'module'; const require = createRequire(import.meta.url);`,
    },
  },
  {
    entry: ["iac/index.ts"],
    format: ["esm", "cjs"],
    dts: true,
    outDir: "dist/iac",
    external: ["@hot-updater/cloudflare"],
    banner: {
      js: `import { createRequire } from 'module'; const require = createRequire(import.meta.url);`,
    },
  },
]);
