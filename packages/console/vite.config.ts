import { readFileSync } from "node:fs";
import tailwindcss from "@tailwindcss/vite";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";
import viteTsConfigPaths from "vite-tsconfig-paths";

const reactNativePackage = JSON.parse(
  readFileSync(new URL("../hot-updater/package.json", import.meta.url), "utf8"),
) as {
  version: string;
};

const config = defineConfig({
  define: {
    "import.meta.env.VITE_HOT_UPDATER_SDK_VERSION": JSON.stringify(
      reactNativePackage.version,
    ),
  },
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
  optimizeDeps: {
    exclude: ["oxc-transform", "@oxc-transform/binding-darwin-arm64"],
  },
  ssr: {
    noExternal: ["@hot-updater/core", "@hot-updater/mock"],
    external: [
      "@hot-updater/cli-tools",
      "oxc-transform",
      "@oxc-transform/binding-darwin-arm64",
      "@oxc-transform/binding-wasm32-wasi",
    ],
  },
  build: {
    rollupOptions: {
      external: [
        "@hot-updater/cli-tools",
        "oxc-transform",
        "@oxc-transform/binding-darwin-arm64",
        "@oxc-transform/binding-wasm32-wasi",
      ],
    },
  },
});

export default config;
