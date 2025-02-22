import { defineConfig } from "vite";
import devServer, { defaultOptions } from "@hono/vite-dev-server";
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
  ],
  server: {
    port: 3000,
  },
});
