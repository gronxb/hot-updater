import devServer from "@hono/vite-dev-server";
import { vitePlugin as remix } from "@remix-run/dev";
import esbuild from "esbuild";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [
    devServer({
      injectClientScript: false,
      entry: "server/index.ts", // The file path of your server.
      exclude: [/^\/(app)\/.+/, /^\/@.+$/, /^\/node_modules\/.*/],
    }),
    remix({
      future: {
        v3_fetcherPersist: true,
        v3_relativeSplatPath: true,
        v3_throwAbortReason: true,
        unstable_singleFetch: true,
      },
      buildDirectory: "build",
      serverBuildFile: "remix.js",
      buildEnd: async () => {
        await esbuild
          .build({
            alias: { "@": "./app" },
            // The final file name
            outfile: "build/server/index.js",
            // Our server entry point
            entryPoints: ["server/index.ts"],
            // Dependencies that should not be bundled
            // We import the remix build from "../build/server/remix.js", so no need to bundle it again aka remove all paths starting with
            external: ["./build/server/*"],
            platform: "node",
            format: "esm",
            // Don't include node_modules in the bundle
            packages: "external",
            bundle: true,
            logLevel: "info",
          })
          .catch((error: unknown) => {
            console.error(error);
            process.exit(1);
          });
      },
    }),
    tsconfigPaths(),
  ],
});
