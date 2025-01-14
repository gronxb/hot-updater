import * as path from "node:path";
import {
  createTransformerDiff,
  createTransformerHighlight,
  pluginShiki,
} from "@rspress/plugin-shiki";
import { defineConfig } from "rspress/config";

export default defineConfig({
  plugins: [
    pluginShiki({
      transformers: [createTransformerHighlight(), createTransformerDiff()],
    }),
  ],
  root: path.join(__dirname, "docs"),
  title: "Hot Updater",
  icon: "/logo.png",
  logoText: "Hot Updater",
  logo: {
    light: "/logo.png",
    dark: "/logo.png",
  },
  base: "/hot-updater/",
  markdown: {
    defaultWrapCode: true,
  },
  themeConfig: {
    socialLinks: [
      {
        icon: "github",
        mode: "link",
        content: "https://github.com/gronxb/hot-updater",
      },
    ],
  },
});
