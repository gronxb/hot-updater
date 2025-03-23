import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/index.ts", "sdk/index.ts", "migrations/index.ts"],
    format: ["esm", "cjs"],
    outDir: "dist",
    dts: true,
    banner: {
      js: `import { createRequire } from 'module'; const require = createRequire(import.meta.url);`,
    },
  },
  {
    entry: ["lambda/index.ts"],
    format: ["cjs"],
    outDir: "dist/lambda",
  },
]);
