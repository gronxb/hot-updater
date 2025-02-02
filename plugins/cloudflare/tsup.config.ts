import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/utils/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
});
