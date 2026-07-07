import tailwindcss from "@tailwindcss/vite";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";

const config = defineConfig({
  plugins: [
    devtools(),
    nitro({
      compatibilityDate: "2026-07-07",
    }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
  assetsInclude: ["**/*.node"],
  resolve: {
    tsconfigPaths: true,
  },
  optimizeDeps: {
    exclude: ["oxc-transform", "@oxc-transform/binding-darwin-arm64"],
  },
  ssr: {
    noExternal: ["@hot-updater/core"],
    external: [
      "@hot-updater/bsdiff",
      "@hot-updater/cli-tools",
      "oxc-transform",
      "@oxc-transform/binding-darwin-arm64",
      "@oxc-transform/binding-wasm32-wasi",
    ],
  },
  build: {
    rollupOptions: {
      external: [
        "@hot-updater/bsdiff",
        "@hot-updater/cli-tools",
        "oxc-transform",
        "@oxc-transform/binding-darwin-arm64",
        "@oxc-transform/binding-wasm32-wasi",
      ],
    },
  },
});

export default config;
