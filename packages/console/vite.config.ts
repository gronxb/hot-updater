import tailwindcss from "@tailwindcss/vite";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";
import viteTsConfigPaths from "vite-tsconfig-paths";

const config = defineConfig({
  plugins: [
    devtools(),
    nitro(),
    // this is the plugin that enables path aliases
    viteTsConfigPaths({
      projects: ["./tsconfig.json"],
    }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
  assetsInclude: ["**/*.node"],
  server: {
    allowedHosts: ["gronxb-macmini.taild999d7.ts.net"],
  },
  optimizeDeps: {
    exclude: ["oxc-transform", "@oxc-transform/binding-darwin-arm64"],
  },
  ssr: {
    noExternal: ["@hot-updater/core", "@hot-updater/mock"],
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
