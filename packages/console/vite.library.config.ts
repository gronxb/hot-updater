import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import viteTsConfigPaths from "vite-tsconfig-paths";

const config = defineConfig({
  plugins: [
    viteTsConfigPaths({
      projects: ["./tsconfig.json"],
    }),
    tailwindcss(),
    viteReact(),
  ],
  build: {
    copyPublicDir: false,
    emptyOutDir: false,
    lib: {
      cssFileName: "embedded",
      entry: "./src/embedded.tsx",
      fileName: (_, entryName) => `${entryName}.mjs`,
      formats: ["es"],
    },
    rollupOptions: {
      external: [
        "@hot-updater/cli-tools",
        "react",
        "react-dom",
        "react/jsx-runtime",
      ],
    },
  },
});

export default config;
