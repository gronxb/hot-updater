import devServer from "@hono/vite-dev-server";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    devServer({
      entry: "./nodejs/functions/update-server/index.ts",
    }),
  ],
  server: {
    port: 3000,
  },
});
