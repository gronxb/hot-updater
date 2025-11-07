import tailwindcss from "@tailwindcss/vite";
import mdx from "fumadocs-mdx/vite";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "waku/config";
import { deadLinkCheckerPlugin } from "./plugins/dead-link-checker-plugin";
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
        outputDir: "dist/public",
      }),
      deadLinkCheckerPlugin({
        contentDir: "content/docs",
        failOnError: false,
        exclude: [/^https?:\/\//, /^#/, /^mailto:/],
        checkOnDev: true,
      }),
    ] as any,
  },
});
