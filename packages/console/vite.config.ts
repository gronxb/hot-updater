import devServer, { defaultOptions } from "@hono/vite-dev-server";
import UnpluginTypia from "@ryoppippi/unplugin-typia/vite";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [
    devServer({
      entry: "./src-server/index.ts",
      exclude: ["/src/assets/**", ...defaultOptions.exclude],
    }),
    solid(),
    tsconfigPaths(),
    UnpluginTypia(),
  ],
  server: {
    port: 3000,
  },
});
