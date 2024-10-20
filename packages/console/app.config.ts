import path from "path";
import { fileURLToPath } from "url";
import { defineConfig } from "@tanstack/start/config";

const __dirname = fileURLToPath(import.meta.url);

export default defineConfig({
  server: {
    preset: "node-server",
  },
  vite: {
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./app"),
      },
    },
  },
});
