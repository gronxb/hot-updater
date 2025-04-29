import { defineConfig } from "@rslib/core";

export default defineConfig({
  lib: [
    {
      output: {
        externals: ["react-native"],
      },
      format: "esm",
      dts: true,
    },
    {
      output: {
        externals: ["react-native"],
      },
      format: "cjs",
      dts: true,
    },
  ],
});
