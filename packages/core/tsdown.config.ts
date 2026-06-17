import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: ["src/index.ts", "src/dbSchemaArtifacts.ts"],
    format: ["esm", "cjs"],
    outDir: "dist",
    dts: true,
    exports: true,
    failOnWarn: true,
  },
]);
