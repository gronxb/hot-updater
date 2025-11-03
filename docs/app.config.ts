import { defineConfig } from "@tanstack/start/config";
import { fumadocsVitePlugin } from "fumadocs-mdx/vite";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  vite: {
    plugins: [
      fumadocsVitePlugin({
        mdxOptions: {},
      }),
      tailwindcss(),
    ],
  },
  server: {
    preset: "cloudflare-pages",
  },
});
