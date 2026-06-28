import { resolve } from "node:path";

import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const externalDependencies: RegExp[] = [
  /^node:.+$/,
  /^@hot-updater\/.+$/,
  /^@tanstack\/react-query$/,
  /^react(?:\/.*)?$/,
  /^react-dom(?:\/.*)?$/,
];

const syncExternalStoreWithSelector = resolve(
  import.meta.dirname,
  "src/lib/use-sync-external-store-with-selector.ts",
);

export default defineConfig({
  plugins: [tailwindcss(), viteReact()],
  resolve: {
    alias: [
      {
        find: "use-sync-external-store/shim/with-selector",
        replacement: syncExternalStoreWithSelector,
      },
      {
        find: "use-sync-external-store/shim/with-selector.js",
        replacement: syncExternalStoreWithSelector,
      },
      {
        find: "use-sync-external-store/with-selector",
        replacement: syncExternalStoreWithSelector,
      },
      {
        find: "use-sync-external-store/with-selector.js",
        replacement: syncExternalStoreWithSelector,
      },
    ],
    tsconfigPaths: true,
  },
  build: {
    emptyOutDir: true,
    lib: {
      entry: {
        embedded: resolve(import.meta.dirname, "src/embedded.tsx"),
        hosted: resolve(import.meta.dirname, "src/lib/server/hosted.server.ts"),
      },
      cssFileName: "embedded",
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
