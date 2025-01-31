import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/utils/index.ts"],
  format: ["esm"],
  dts: true,
  banner: {
    js: `import { createRequire } from 'module'; const require = createRequire(import.meta.url);`,
  },
});
