import path from "path";
import type { BuildPluginArgs } from "@hot-updater/plugin-core";
import fs from "fs/promises";
import Metro from "metro";
import type { InputConfigT } from "metro-config";
import Server from "metro/src/Server";

export const metro =
  (overrideConfig?: InputConfigT) =>
  async ({ cwd, platform }: BuildPluginArgs) => {
    const config = await Metro.loadConfig({}, overrideConfig);

    const buildPath = path.join(cwd, "build");

    await fs.rm(buildPath, { recursive: true, force: true });
    await fs.mkdir(buildPath, { recursive: true });

    const bundleOutput = path.join(cwd, "build", `index.${platform}.bundle`);
    const outputs: string[] = [];

    await Metro.runBuild(config, {
      entry: "index.js",
      output: {
        build: async (server, options) => {
          const bundleOptions = {
            ...Server.DEFAULT_BUNDLE_OPTIONS,
            ...options,
          };

          // copy assets
          const assets = await server.getAssets({
            ...bundleOptions,
            bundleType: "bundle",
          });

          let copyTargetFiles: { from: string; to: string }[] = [];

          switch (platform) {
            case "ios": {
              copyTargetFiles = assets
                .flatMap((asset) => asset.files)
                .map((file) => {
                  const resolvedPath = file.replace(cwd, "");
                  return {
                    from: file,
                    to: path.join(buildPath, "assets", resolvedPath),
                  };
                });
              break;
            }
            case "android": {
              copyTargetFiles = assets
                .flatMap((asset) => asset.files)
                .map((file) => {
                  const resolvedPath = file
                    .replace(`${cwd}/`, "")
                    .replace(/\/|\\/g, "_");
                  return {
                    from: file,
                    to: path.join(buildPath, "drawable-mdpi", resolvedPath),
                  };
                });
              break;
            }
          }

          await Promise.all(
            copyTargetFiles.map(async ({ from, to }) => {
              await fs.mkdir(path.dirname(to), { recursive: true });
              await fs.copyFile(from, to);
              outputs.push(to);
            }),
          );

          return server.build(bundleOptions);
        },
        save: async ({ code, map }, options) => {
          outputs.push(options.bundleOutput);
          await fs.writeFile(options.bundleOutput, code);

          if (options.sourcemapOutput) {
            outputs.push(options.sourcemapOutput);
            await fs.writeFile(options.sourcemapOutput, map);
          }
        },
      },
      out: bundleOutput,
      platform,
      minify: true,
      sourceMap: true,
    });
    return {
      buildPath,
      outputs,
    };
  };
