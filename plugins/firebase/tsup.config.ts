import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["./src/index.ts"],
    format: ["esm", "cjs"],
    outDir: "dist",
    dts: true,
  },
  {
    entry: ["firebase/functions/index.ts"],
    format: ["cjs"],
    outDir: "dist/firebase",
    external: ["firebase-functions", "firebase-admin"],
    noExternal: ["@hot-updater/core", "@hot-updater/js"],
  },
  {
    entry: ["iac/index.ts"],
    format: ["esm", "cjs"],
    dts: true,
    outDir: "dist/iac",
    external: ["@hot-updater/firebase"],
    banner: {
      js: `import { createRequire } from 'module'; const require = createRequire(import.meta.url);`,
    },
  },
]);
