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
      output: {
        entryFileNames: "vite.mjs",
      },
    },
    ssr: "./src/vite.ts",
  },
});

export default config;
