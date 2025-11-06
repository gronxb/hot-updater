import tailwindcss from "@tailwindcss/vite";
import mdx from "fumadocs-mdx/vite";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "waku/config";
import { llmsTxtPlugin } from "./plugins/llms-txt-plugin";
import * as MdxConfig from "./source.config.js";

export default defineConfig({
  vite: {
    plugins: [
      tailwindcss(),
      mdx(MdxConfig),
      tsconfigPaths(),
      llmsTxtPlugin({
        baseUrl: "https://hot-updater.dev",
        githubRepo: "https://github.com/gronxb/hot-updater",
      }),
    ],
  },
});
