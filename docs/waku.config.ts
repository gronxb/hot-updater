import tailwindcss from "@tailwindcss/vite";
import mdx from "fumadocs-mdx/vite";
import { defineConfig } from "waku/config";

import { deadLinkCheckerPlugin } from "./plugins/dead-link-checker-plugin";
import { llmsTxtPlugin } from "./plugins/llms-txt-plugin";
import * as MdxConfig from "./source.config.js";

export default defineConfig({
  vite: {
    plugins: [
      tailwindcss(),
      mdx(MdxConfig),
      llmsTxtPlugin({
        baseUrl: "https://hot-updater.dev",
        contentDir: "content/docs/(latest)",
      }),
      llmsTxtPlugin({
        baseUrl: "https://hot-updater.dev",
        contentDir: "content/docs/v0",
        generateIndex: false,
        urlPrefix: "v0",
      }),
      deadLinkCheckerPlugin({
        contentDir: "content/docs",
        failOnError: false,
        exclude: [/^https?:\/\//, /^#/, /^mailto:/],
        checkOnDev: true,
      }),
    ],
    resolve: {
      tsconfigPaths: true,
    },
  },
});
