import fs from "fs";
import path from "path";
import {
  type BasePluginArgs,
  type BuildPlugin,
  getCwd,
} from "@hot-updater/plugin-core";
import type { SentryCliOptions } from "@sentry/cli";
import SentryCli from "@sentry/cli";

export const withSentry =
  (buildFn: (args: BasePluginArgs) => BuildPlugin, config: SentryCliOptions) =>
  (args: BasePluginArgs): BuildPlugin => {
    const context = buildFn(args);
    return {
      ...context,
      build: async (args) => {
        const result = await context.build(args);
        const sentry = new SentryCli(null, config);

        const include: string[] = [];
        const files = await fs.promises.readdir(result.buildPath, {
          recursive: true,
        });
        for (const file of files) {
          if (file.endsWith(".map")) {
            include.push(path.join(result.buildPath, file));
          }
        }

        if (include.length === 0) {
          throw new Error("No source maps found");
        }

        await sentry.releases.uploadSourceMaps(result.bundleId, {
          include,
          sourceMapReference: true,
          dist: `${args.platform}.${args.channel}.${result.bundleId}`,
          stripPrefix: [getCwd()],
        });

        // const sourcemapFile = files.find((file) => file.endsWith(".map"));
        // const sourcemapPath = sourcemapFile
        //   ? path.join(result.buildPath, sourcemapFile)
        //   : null;

        // if (!sourcemapPath) {
        //   throw new Error("No source maps found");
        // }
        // await sentry.execute(
        //   [
        //     "sourcemaps",
        //     "upload",
        //     "--debug-id-reference",
        //     "--strip-prefix",
        //     getCwd(),
        //     "--bundle",
        //     sourcemapPath,
        //     "--dist",
        //     `${args.platform}.${args.channel}.${result.bundleId}`,
        //   ],
        //   true,
        // );

        return result;
      },
    };
  };
