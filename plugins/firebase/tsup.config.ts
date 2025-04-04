import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["firebase/functions/index.ts"],
    format: ["cjs"],
    outDir: "dist/firebase",
    external: [
      "fs",
      "path",
      "crypto",
      "stream",
      "util",
      "events",
      "buffer",
      "os",
      "child_process",
    ],
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
