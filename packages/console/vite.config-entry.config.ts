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
    lib: {
      entry: "./src/config.ts",
      fileName: (_, entryName) => `${entryName}.mjs`,
      formats: ["es"],
    },
    outDir: "dist",
  },
});

export default config;
