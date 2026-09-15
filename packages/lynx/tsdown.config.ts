import { defineConfig } from "tsdown";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/build.ts",
    "src/navigation.ts",
    "src/navigationProvenance.ts",
  ],
  format: ["esm", "cjs"],
  outDir: "dist",
  dts: true,
  exports: true,
  failOnWarn: true,
});
