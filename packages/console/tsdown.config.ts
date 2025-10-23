import UnpluginTypiaRolldownPlugin from "@ryoppippi/unplugin-typia/rolldown";
import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: ["src-server/index.ts"],
    format: ["esm", "cjs"],
    outDir: "dist",
    dts: true,
    exports: true,
    failOnWarn: true,
    shims: true,
    env: {
      PROD: true,
    },
    clean: false,
    plugins: [UnpluginTypiaRolldownPlugin()],
  },
]);
