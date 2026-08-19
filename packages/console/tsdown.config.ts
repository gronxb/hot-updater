import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["./src/index.ts", "./src/vite.ts"],
  format: ["esm"],
  outDir: "lib",
  dts: true,
  clean: true,
  unbundle: true,
  exports: false,
  failOnWarn: true,
});
