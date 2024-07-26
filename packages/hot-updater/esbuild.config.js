
import { context } from "esbuild";
import packageJson from "./package.json" assert { type: "json" };

const watch = process.argv.includes("--watch");

context({
  entryPoints: ["src/cli.tsx"],
  bundle: true,
  platform: "neutral",
  outfile: "lib/index.mjs",
  define: {
    "process.env.VERSION": `'${packageJson.version}'`,
  },
  external: [
    ...Object.keys({
      ...packageJson.dependencies,
      ...packageJson.devDependencies,
    }),
    "fs",
    "util",
    "path",
    "child_process",
    "crypto",
  ],
}).then((ctx) =>
  watch ? ctx.watch() : ctx.rebuild().then(() => ctx.dispose()),
);
