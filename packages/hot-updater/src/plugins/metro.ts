import fs from "node:fs/promises";
import path from "node:path";
import { cwd } from "@/cwd";
import Metro from "metro";
import type { InputConfigT } from "metro-config";
import Server from "metro/src/Server";

export const metro = (overrideConfig?: InputConfigT) => async () => {
  const config = await Metro.loadConfig({}, overrideConfig);

  const basePath = cwd();
  const buildPath = path.join(basePath, "build");

  await fs.rm(buildPath, { recursive: true, force: true });
  await fs.mkdir(buildPath);

  await Metro.runBuild(config, {
    entry: "index.js",
    output: {
      build: async (server, options) => {
        const bundleOptions = { ...Server.DEFAULT_BUNDLE_OPTIONS, ...options };

        const assets = await server.getAssets({
          ...bundleOptions,
          bundleType: "bundle",
        });

        const copyTargetFiles = assets
          .flatMap((asset) => asset.files)
          .map((file) => {
            const resolvedPath = file.replace(basePath, "");
            return {
              from: file,
              to: path.join(buildPath, resolvedPath),
            };
          });

        await Promise.all(
          copyTargetFiles.map(async ({ from, to }) => {
            await fs.mkdir(path.dirname(to), { recursive: true });
            await fs.copyFile(from, to);
          }),
        );

        return server.build(bundleOptions);
      },
      save: async ({ code, map }, options) => {
        await fs.writeFile(options.bundleOutput, code);
        if (options.sourcemapOutput) {
          await fs.writeFile(options.sourcemapOutput, map);
        }
      },
    },
    out: path.join(basePath, "build", "index.ios.bundle"),
    platform: "ios",
    minify: true,
    sourceMap: true,
  });

  console.log("Build completed");
};
