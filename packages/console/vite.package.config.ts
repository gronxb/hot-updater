import { resolve } from "node:path";

import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const externalDependencies: RegExp[] = [
  /^node:.+$/,
  /^@hot-updater\/.+$/,
  /^@tanstack\/react-query$/,
  /^react(?:\/.*)?$/,
  /^react-dom(?:\/.*)?$/,
];

export default defineConfig({
  plugins: [viteReact()],
  resolve: {
    tsconfigPaths: true,
  },
  build: {
    emptyOutDir: true,
    lib: {
      entry: {
        embedded: resolve(import.meta.dirname, "src/embedded.tsx"),
        hosted: resolve(import.meta.dirname, "src/lib/server/hosted.server.ts"),
      },
      formats: ["es"],
    },
    outDir: "dist",
    rollupOptions: {
      external: externalDependencies,
      output: {
        entryFileNames: "[name].mjs",
      },
    },
  },
});
