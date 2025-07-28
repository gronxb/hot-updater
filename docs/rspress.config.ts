import * as path from "node:path";
import { pluginLlms } from "@rspress/plugin-llms";
import {
  transformerNotationDiff,
  transformerNotationHighlight,
} from "@shikijs/transformers";
import { defineConfig } from "rspress/config";

export default defineConfig({
  plugins: [pluginLlms()],
  root: path.join(__dirname, "docs"),
  title: "Hot Updater",
  icon: "/logo.png",
  logoText: "Hot Updater",
  logo: {
    light: "/logo.png",
    dark: "/logo.png",
  },
  markdown: {
    showLineNumbers: true,
    defaultWrapCode: true,
    shiki: {
      transformers: [transformerNotationDiff(), transformerNotationHighlight()],
    },
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
