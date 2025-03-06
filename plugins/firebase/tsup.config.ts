import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["firebase/functions/index.ts"],
    format: ["cjs"],
    outDir: "firebase/functions/",
    external: [
      "fs",
      "path",
      "crypto",
      "stream",
      "util",
      "events",
      "buffer",
      "os",
      "child_process",
    ],
  },
]);
