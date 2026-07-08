import { defineConfig } from "vite";
import viteTsConfigPaths from "vite-tsconfig-paths";

const config = defineConfig({
  plugins: [
    viteTsConfigPaths({
      projects: ["./tsconfig.json"],
    }),
  ],
  build: {
    emptyOutDir: false,
    outDir: "dist",
    rollupOptions: {
      external: ["@hot-updater/cli-tools"],
      output: {
        chunkFileNames: "hosted-[name]-[hash].mjs",
        entryFileNames: "hosted.mjs",
      },
    },
    ssr: "./src/hosted.ts",
  },
});

export default config;
