import { defineConfig } from "@rsbuild/core";
import { pluginBabel } from "@rsbuild/plugin-babel";
import { pluginSolid } from "@rsbuild/plugin-solid";

export default defineConfig({
  html: {
    title: "Hot Updater Console",
    inject: "body",
  },
  plugins: [
    pluginBabel({
      include: /\.(?:jsx|tsx)$/,
    }),
    pluginSolid(),
  ],
  output: {
    copy: {
      patterns: [
        { from: "logo.png", to: "logo.png" },
        { from: "preload.js", to: "preload.js" },
        { from: "main.mjs", to: "main.mjs" },
      ],
    },
    inlineScripts: true,
    inlineStyles: true,
  },
});
