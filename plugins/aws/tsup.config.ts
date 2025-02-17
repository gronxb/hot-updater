import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "sdk/index.ts", "lambda/index.ts"],
  format: ["esm", "cjs"],
  outDir: "dist",
  dts: true,
  banner: {
    js: `import { createRequire } from 'module'; const require = createRequire(import.meta.url);`,
  },
});
