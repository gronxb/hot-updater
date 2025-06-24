import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/adapters/index.ts"],
  format: ["cjs", "esm"],
  dts: true,
  clean: true,
});